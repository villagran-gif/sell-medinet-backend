const LOCATIONS = {
  39: { name:'Antofagasta Mall Arauco Express', address:'Av. Edmundo Pérez Zujovic 5440, 4° piso, Antofagasta' },
  41: { name:'Santiago', address:'Av. Apoquindo 4775, Las Condes, Santiago' },
  4: { name:'Calama - DiagnoSalud', address:'Av. Granaderos 1483, DiagnoSalud, Calama' },
};

const maps = address => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

export function locationDetails(snapshot={}) {
  const type=String(snapshot.type||'').toLowerCase();
  if(type.includes('telemedicina')) return {kind:'telemedicine',text:'Modalidad: Telemedicina.'};
  const loc=LOCATIONS[Number(snapshot.branchId)];
  if(!loc) return {kind:'branch',text:snapshot.branch?`Sede: ${snapshot.branch}.`:''};
  return {kind:'physical',text:`Sede: ${loc.name}\nDirección: ${loc.address}\nMapa: ${maps(loc.address)}`};
}
