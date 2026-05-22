/**
 * Datos estáticos por sucursal que NO vienen de Medinet:
 * - Link de Google Maps (cómo llegar)
 * - Extras (parking, accesos, instrucciones especiales)
 *
 * La DIRECCIÓN sí viene de Medinet (sucursal.direccion → branch_address en
 * el intake). Acá solo lo que Medinet no provee.
 *
 * Keyed por branch_id. Para agregar/cambiar una sucursal, editar este map.
 */

// Link de Google Maps por sucursal. Las sucursales de telemedicina (2, 3)
// no tienen ubicación física → null (el mensaje omite la línea de mapa).
export const BRANCH_MAPS = Object.freeze({
  4:  "https://maps.app.goo.gl/TgWgCDBfxqfGucsh9", // Diagno Salud Calama (Av. Granaderos 1483, Calama)
  38: "https://maps.app.goo.gl/YxcA8h9rrqCpEA1cA", // Hospital Militar del Norte (Gral. Borgoño 957, Antofagasta)
  39: "https://maps.app.goo.gl/aTLwDrryP69Wbfkv6", // Antofagasta Mall Arauco
  41: "https://maps.app.goo.gl/7K6w4458n8CgnQQ97", // Santiago (Clínica Apoquindo)
});

// Extras estáticos (parking, accesos). Se agregan al mensaje de confirmación.
export const BRANCH_EXTRAS = Object.freeze({
  39: "🅿️ Contamos con 150 estacionamientos subterráneos (ingreso al final de la calle lateral).",
});

export function branchMapLink(branchId) {
  return BRANCH_MAPS[Number(branchId)] || null;
}

export function branchExtras(branchId) {
  return BRANCH_EXTRAS[Number(branchId)] || null;
}
