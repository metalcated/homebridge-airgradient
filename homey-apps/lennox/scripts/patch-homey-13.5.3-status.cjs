#!/usr/bin/env node
'use strict';

// Scoped presentation changes for the reviewed Homey 13.5.3 web application.
const DRIVER = 'homey:app:com.metalcated.lennox:thermostat';
const CHANGES = [
  ['let e=[],t=n?.capabilitiesObj,i=EW;if(t==null)',
    `let e=[],t=n?.capabilitiesObj,i=EW,lennoxIndicator=n?.driverId===\`${DRIVER}\`;if(t==null)`],
  ['for(let[n,a]of Object.entries(t))if(!(a.id===`onoff`||a.id===`button`))',
    'for(let[n,a]of Object.entries(t))if((!lennoxIndicator||[`measure_temperature`,`measure_humidity`,`hvac_state`].includes(n))&&!(a.id===`onoff`||a.id===`button`))'],
  ['else if(a.type===`string`){let t={...a};t.default=!1,e.push(t)}}return e.push({id:`.none`',
    'else if(a.type===`string`||lennoxIndicator&&a.id===`hvac_state`){let t={...a};t.default=!1,e.push(t)}}return e.push({id:`.none`'],
  ['function r(){let e=n?.class,t=n?.virtualClass,r=[`light`,`speaker`,`thermostat`,`lock`];',
    `function r(){if(n?.driverId===\`${DRIVER}\`)return!0;let e=n?.class,t=n?.virtualClass,r=[\`light\`,\`speaker\`,\`thermostat\`,\`lock\`];`],
  ['case t.type===`string`:e.push({key:t.id,textValue:t.title,indicator:(0,L.jsx)(xW,{device:n,capabilityId:t.id})})',
    `case t.type===\`string\`||n?.driverId===\`${DRIVER}\`&&t.id===\`hvac_state\`:e.push({key:t.id,textValue:t.title,indicator:(0,L.jsx)(xW,{device:n,capabilityId:t.id})})`],
  ['case n===`thermostat`:a.Component=aTe;break;case i!=null&&e.capabilitiesObj[i]?.type===`string`:',
    `case e.driverId===\`${DRIVER}\`&&i===\`hvac_state\`:a.Component=xW;break;case n===\`thermostat\`&&!(e.driverId===\`${DRIVER}\`&&[\`measure_temperature\`,\`measure_humidity\`].includes(r)):a.Component=aTe;break;case i!=null&&e.capabilitiesObj[i]?.type===\`string\`:`],
];

function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  for (const [before, after] of CHANGES) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw Error(`Expected one reviewed status fragment; found ${count}`);
    source = source.replace(before, after);
  }
  return source;
}

module.exports = { DRIVER, CHANGES, transformSource };
