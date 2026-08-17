function hasCoordinates(lat,lng){ return lat!==null&&lat!==undefined&&lat!==''&&lng!==null&&lng!==undefined&&lng!==''&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng)); }
function isOptionalCoordinate(value){ return value===null||value===undefined||value===''||Number.isFinite(Number(value)); }
