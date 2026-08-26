const fs = require('fs');

const source = 'Arquivos/PONTOS GPS SUÍNOS - GEOREFERENCIAMENTO.csv';
const destination = 'dados-integrados.js';
const text = fs.readFileSync(source, 'utf8');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { values.push(value.trim()); value = ''; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function parseCoordinate(value) {
  const match = String(value || '').replace(/\u00a0/g, ' ').match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const coords = [Number(match[1]), Number(match[2])];
  return coords[0] >= -34 && coords[0] <= -25 && coords[1] >= -58 && coords[1] <= -48 ? coords : null;
}

function integratedName(name) {
  return String(name || '')
    .replace(/\s*(?:-\s*)?(?:\(\s*)?GP\s*0*\d+\s*(?:\))?\s*$/i, '')
    .replace(/\s+TP\s*\d+\s*$/i, '')
    .trim();
}

const unique = new Map();
text.split(/\r?\n/).filter((line) => line.trim()).slice(1).map(parseCsvLine).forEach((row) => {
  const name = integratedName(row[8]);
  const coords = parseCoordinate(row[12]);
  const key = name.toLocaleLowerCase();
  if (name && coords && !unique.has(key)) unique.set(key, { name, city: row[10] || 'Município não informado', coords });
});

fs.writeFileSync(destination, `window.INTEGRATED_DATA = ${JSON.stringify([...unique.values()])};\n`);
console.log(`Dados gerados: ${unique.size} integrados`);
