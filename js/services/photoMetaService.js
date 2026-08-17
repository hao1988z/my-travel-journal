// ── EXIF 讀取 ──
async function readExif(file) {
  try {
    if (typeof exifr === 'undefined') return null;
    const data = await exifr.parse(file, {pick:['Make','Model','FNumber','ExposureTime','ISO','DateTimeOriginal','GPSLatitude','GPSLongitude','LensModel']});
    if (!data) return null;
    return {
      camera: [data.Make, data.Model].filter(Boolean).join(' ')||null,
      lens: data.LensModel||null,
      aperture: data.FNumber ? `f/${data.FNumber}` : null,
      shutter: data.ExposureTime ? (data.ExposureTime<1?`1/${Math.round(1/data.ExposureTime)}s`:`${data.ExposureTime}s`) : null,
      iso: data.ISO ? `ISO ${data.ISO}` : null,
      date: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toLocaleDateString('zh-TW') : null,
      lat: data.GPSLatitude||null, lng: data.GPSLongitude||null,
    };
  } catch(e) { return null; }
}

function renderLbExif(exif) {
  const el = document.getElementById('lb-exif'); if (!el) return;
  if (!exif) { el.innerHTML = ''; return; }
  const parts = [exif.camera&&`📷 ${exif.camera}`, exif.aperture&&exif.shutter&&`${exif.aperture} · ${exif.shutter}`, exif.iso, exif.date&&`📅 ${exif.date}`].filter(Boolean);
  el.innerHTML = parts.map(p=>`<span>${p}</span>`).join('');
}
