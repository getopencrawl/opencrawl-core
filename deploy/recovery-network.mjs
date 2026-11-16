// Restore every service with a reserved address. Completed initialization jobs
// have no live Docker IP in a snapshot; restarting them dynamically can consume
// an address needed by a later service or the retained Airbyte node.
function address(value){
  if(typeof value!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))throw new Error('Invalid recovery IPv4 address');
  const parts=value.split('.').map(Number);if(parts.some(part=>part>255))throw new Error('Invalid recovery IPv4 address');
  return parts.reduce((total,part)=>total*256+part,0);
}
const dotted=value=>[24,16,8,0].map(shift=>Math.floor(value/2**shift)%256).join('.');
function range(config){
  const [base,prefix,...extra]=String(config.subnet||'').split('/'),bits=Number(prefix);
  if(extra.length||!/^\d{1,2}$/.test(prefix||'')||bits<0||bits>30)throw new Error('Unsupported recovery IPv4 subnet');
  const start=address(base),size=2**(32-bits);if(start%size)throw new Error('Invalid recovery IPv4 subnet');
  return {start,end:start+size-1,gateway:config.gateway?address(config.gateway):start+1};
}
export function recoveryCompose(snapshot){
  const compose=structuredClone(snapshot.compose),network=compose.networks?.default;
  if(!network)return compose;
  const ranges=(network.ipam?.config||[]).map(range);if(!ranges.length)throw new Error('Recovery network requires its original IPv4 subnets');
  const occupied=new Set(ranges.flatMap(value=>[value.start,value.end,value.gateway]));
  const claim=value=>{const ip=address(value);if(!ranges.some(range=>ip>range.start&&ip<range.end)||occupied.has(ip))throw new Error('Recovery network address conflicts with another saved endpoint');occupied.add(ip);};
  if(snapshot.airbyte)claim(snapshot.airbyte.address);
  for(const service of Object.values(compose.services)){
    if(service.networks&&Object.keys(service.networks).some(key=>key!=='default'))throw new Error('Unsupported recovery service network');
    const ip=service.networks?.default?.ipv4_address;if(ip)claim(ip);
  }
  for(const name of Object.keys(compose.services).sort()){
    const service=compose.services[name];if(service.networks?.default?.ipv4_address)continue;
    let free;
    for(const range of ranges){for(let ip=range.start+1;ip<range.end;ip++){if(!occupied.has(ip)){free=ip;break;}}if(free!==undefined)break;}
    if(free===undefined)throw new Error('Recovery network has no free address for initialization services');
    occupied.add(free);service.networks={default:{...service.networks?.default,ipv4_address:dotted(free)}};
  }
  return compose;
}
