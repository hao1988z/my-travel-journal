import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const photoBucket = Deno.env.get("PHOTO_BUCKET") || "photos";
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
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((photo) => photo && typeof photo === "object")
    .map((photo) => ({
      ...photo,
      storage_path: photo.storage_path || photo.path || ""
    }))
    .filter((photo) => photo.storage_path);
}

async function signPhotoPaths(paths: string[]) {
  const signedByPath = new Map<string, string>();
  const uniquePaths = [...new Set(paths.filter(Boolean))];

  // Keep batches small so a large travel album does not exceed the Storage request limit.
  for (let index = 0; index < uniquePaths.length; index += 100) {
    const batch = uniquePaths.slice(index, index + 100);
    const { data, error } = await admin.storage
      .from(photoBucket)
      .createSignedUrls(batch, 60 * 60);
    if (error) {
      console.error("[get-shared-trip.signPhotos]", error);
      continue;
    }
    (data || []).forEach((item) => {
      if (item?.path && item.signedUrl) signedByPath.set(item.path, item.signedUrl);
    });
  }

  return signedByPath;
}

async function loadPhotos(trip: Record<string, unknown>) {
  const modernResult = await admin
    .from("trip_photos")
    .select("*")
    .eq("trip_id", trip.id)
    .order("created_at", { ascending: true });

  const modernTableMissing = modernResult.error?.code === "PGRST205" || modernResult.error?.code === "42P01";
  const legacyRows = parsePhotosMeta(trip.photos_meta);
  const modernRows = !modernResult.error ? (modernResult.data || []) : [];
  const rows = modernRows.length
    ? modernRows
    : modernTableMissing || !modernResult.error
      ? legacyRows
      : [];

  if (modernResult.error && !modernTableMissing) {
    console.error("[get-shared-trip.loadPhotos]", modernResult.error);
  }

  const signedByPath = await signPhotoPaths(rows.map((photo) => photo.storage_path || photo.path));
  return rows
    .map((photo) => {
      const storagePath = photo.storage_path || photo.path;
      return {
        ...photo,
        storage_path: storagePath,
        signed_url: signedByPath.get(storagePath) || ""
      };
    })
    .filter((photo) => photo.signed_url);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Function secrets are not configured" }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body?.share_token || body?.token || "").trim();
    if (!token || token.length > 200) return jsonResponse({ error: "Invalid share token" }, 400);

    const { data: trip, error } = await admin
      .from("trips")
      .select("*")
      .eq("share_token", token)
      .eq("is_shared", true)
      .maybeSingle();

    if (error) {
      console.error("[get-shared-trip.trip]", error);
      return jsonResponse({ error: "Unable to load shared trip" }, 500);
    }
    if (!trip) return jsonResponse({ error: "Shared trip not found" }, 404);

    const photos = await loadPhotos(trip);
    const { user_id: _userId, ...safeTrip } = trip;
    const normalizedTrip = {
      ...safeTrip,
      title: trip.title ?? trip.name ?? null,
      location_name: trip.location_name ?? trip.location ?? "",
      travel_date: trip.travel_date ?? trip.date_start ?? null,
      travel_date_end: trip.travel_date_end ?? trip.date_end ?? null,
      photos,
      trip_photos: photos,
      share_token: token
    };

    return jsonResponse(normalizedTrip);
  } catch (error) {
    console.error("[get-shared-trip]", error);
    return jsonResponse({ error: "Unable to load shared trip" }, 500);
  }
});
