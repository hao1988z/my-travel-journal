import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const photoBucket = Deno.env.get("PHOTO_BUCKET") || "trip-photos";
const MAX_GUEST_UPLOAD_FILES = 200;
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function parsePhotosMeta(value: unknown) {
  if (!value) return [];
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try { return JSON.parse(value); } catch { return []; }
        })()
      : [];
  return Array.isArray(parsed) ? parsed.filter((photo) => photo && typeof photo === "object") : [];
}

function extensionFor(file: File) {
  const fromType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif"
  }[file.type.toLowerCase()];
  if (fromType) return fromType;
  const fromName = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return fromName && ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(fromName)
    ? fromName
    : "jpg";
}

function publicPhotoMeta(photo: Record<string, unknown> | null, fallback: Record<string, unknown>) {
  return {
    id: photo?.id ?? null,
    storage_path: photo?.storage_path || fallback.storage_path,
    original_name: photo?.original_name || fallback.original_name || null,
    caption: typeof photo?.caption === "string" ? photo.caption : ""
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Function secrets are not configured" }, 500);

  const uploadedPaths: string[] = [];
  let failureStage = "request";
  try {
    failureStage = "parse-request";
    const form = await request.formData();
    const token = String(form.get("share_token") || form.get("token") || "").trim();
    const formFiles = [...form.getAll("photos"), ...form.getAll("photo")];
    const files = formFiles.filter((value): value is File => value instanceof File);
    if (!token || token.length > 200) return jsonResponse({ error: "Invalid share token" }, 400);
    if (!files.length) return jsonResponse({ error: "Please upload at least one image" }, 400);
    if (files.length > MAX_GUEST_UPLOAD_FILES) {
      return jsonResponse({ error: `You can upload up to ${MAX_GUEST_UPLOAD_FILES} photos at a time` }, 400);
    }
    if (files.some((file) => !file.type.startsWith("image/"))) {
      return jsonResponse({ error: "Please upload image files only" }, 400);
    }
    if (files.some((file) => file.size > 25 * 1024 * 1024)) {
      return jsonResponse({ error: "Each photo must be 25 MB or smaller" }, 413);
    }

    failureStage = "load-trip";
    const { data: trip, error: tripError } = await admin
      .from("trips")
      .select("*")
      .eq("share_token", token)
      .eq("is_shared", true)
      .maybeSingle();
    if (tripError) return jsonResponse({ error: "Unable to load shared trip" }, 500);
    if (!trip) return jsonResponse({ error: "Shared trip not found" }, 404);
    // Keep compatibility with trips created before the share-permission
    // migration, which used allow_guest_upload instead.
    const canGuestUpload = trip.can_guest_upload ?? trip.allow_guest_upload ?? false;
    if (canGuestUpload !== true) return jsonResponse({ error: "Guest uploads are disabled" }, 403);

    const photoRows: Record<string, unknown>[] = [];
    failureStage = "storage-upload";
    for (const file of files) {
      const extension = extensionFor(file);
      const storagePath = `${trip.user_id}/${trip.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await admin.storage
        .from(photoBucket)
        .upload(storagePath, file, { cacheControl: "3600", upsert: false, contentType: file.type });
      if (uploadError) {
        console.error("[upload-shared-photo.storage]", uploadError);
        throw new Error("Photo upload failed");
      }
      uploadedPaths.push(storagePath);
      photoRows.push({
        trip_id: trip.id,
        // Owner uploads already populate this required column. Shared uploads
        // still belong to the trip owner; the guest is not an authenticated DB user.
        owner_id: trip.user_id,
        storage_path: storagePath,
        original_name: file.name
      });
    }

    failureStage = "photo-metadata-insert";
    const modernResult = await admin
      .from("trip_photos")
      .insert(photoRows);

    if (!modernResult.error) {
      const photos = photoRows;
      return jsonResponse({
        ok: true,
        count: photos.length,
        photos: photos.map((photo) => publicPhotoMeta(photo, photo)),
        photo: photos[0] ? publicPhotoMeta(photos[0], photos[0]) : null
      });
    }

    const tableMissing = modernResult.error.code === "PGRST205" || modernResult.error.code === "42P01";
    if (!tableMissing) {
      console.error("[upload-shared-photo.metadata]", modernResult.error);
      const metadataError = new Error("Photo metadata insert failed");
      (metadataError as Error & { code?: string }).code = modernResult.error.code || "UNKNOWN";
      throw metadataError;
    }

    failureStage = "legacy-metadata-update";
    const photos = parsePhotosMeta(trip.photos_meta);
    const legacyPhotos = files.map((file, index) => ({
      path: uploadedPaths[index],
      original_name: file.name,
      caption: ""
    }));
    const { error: legacyError } = await admin
      .from("trips")
      .update({ photos_meta: JSON.stringify([...photos, ...legacyPhotos]), photo_count: photos.length + legacyPhotos.length })
      .eq("id", trip.id);
    if (legacyError) throw legacyError;

    return jsonResponse({
      ok: true,
      count: legacyPhotos.length,
      photos: legacyPhotos.map((photo) => publicPhotoMeta(null, photo)),
      photo: publicPhotoMeta(null, legacyPhotos[0])
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? "Unknown error");
    const errorCode = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    console.error("[upload-shared-photo]", { stage: failureStage, error: detail });
    if (uploadedPaths.length) {
      const { error: cleanupError } = await admin.storage.from(photoBucket).remove(uploadedPaths);
      if (cleanupError) {
        console.error("[ORPHAN PHOTO]", {
          stage: failureStage,
          paths: uploadedPaths,
          error: cleanupError
        });
      }
    }

    const safeDetails = {
      "storage-upload": "照片檔案儲存失敗，請確認照片格式、大小與 Storage 容量。",
      "photo-metadata-insert": "照片檔案已上傳，但照片資料寫入失敗，請重新部署最新的 upload-shared-photo。",
      "legacy-metadata-update": "照片資料寫入失敗，請確認 trips.photos_meta 欄位。"
    };
    return jsonResponse({
      error: "Photo upload failed",
      code: `GUEST_UPLOAD_${failureStage.replace(/-/g, "_").toUpperCase()}`,
      diagnostic_code: errorCode || null,
      detail: safeDetails[failureStage as keyof typeof safeDetails] || "分享照片服務發生錯誤，請稍後再試。"
    }, 500);
  }
});
