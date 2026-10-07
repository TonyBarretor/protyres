/**
 * Brand normalization: "MICHELIN", "michelin ", "Michellin" -> "Michelin".
 * Unknown brands are kept, title-cased.
 */

const BRANDS: Record<string, string[]> = {
  Michelin: ["michelin", "michellin", "michelín"],
  Bridgestone: ["bridgestone", "bridgeston", "brigestone", "bs"],
  Goodyear: ["goodyear", "good year", "gy"],
  Continental: ["continental", "conti"],
  Pirelli: ["pirelli", "pirelly"],
  Firestone: ["firestone", "fireston"],
  Yokohama: ["yokohama"],
  Hankook: ["hankook", "hancook"],
  Kumho: ["kumho", "kumo", "khumo"],
  Toyo: ["toyo"],
  Dunlop: ["dunlop"],
  BFGoodrich: ["bfgoodrich", "bf goodrich", "bfg", "b.f. goodrich", "b.f.goodrich"],
  General: ["general", "general tire"],
  Cooper: ["cooper"],
  Westlake: ["westlake", "west lake"],
  Triangle: ["triangle", "triángulo"],
  Linglong: ["linglong", "ling long", "leao"],
  Aeolus: ["aeolus"],
  "Double Coin": ["double coin", "doublecoin", "dc"],
  Sailun: ["sailun"],
  Apollo: ["apollo"],
  Giti: ["giti", "gt radial", "gt-radial", "gtradial"],
  Roadx: ["roadx", "road x"],
  Kapsen: ["kapsen", "habilead"],
  Ovation: ["ovation"],
  Windforce: ["windforce", "wind force"],
  Lanvigator: ["lanvigator"],
  Maxxis: ["maxxis"],
  Nexen: ["nexen", "roadstone"],
  Falken: ["falken"],
  Sumitomo: ["sumitomo"],
  Roadshine: ["roadshine"],
  Goodride: ["goodride"],
  Chaoyang: ["chaoyang", "chao yang"],
  Doublestar: ["doublestar", "double star"],
  Austone: ["austone"],
  Ceat: ["ceat"],
  JK: ["jk", "jk tyre", "jk tyres"],
  Otani: ["otani"],
  Deestone: ["deestone"],
  Boto: ["boto"],
  Annaite: ["annaite"],
  Hilo: ["hilo"],
  Jinyu: ["jinyu"],
  Aplus: ["aplus", "a plus", "a-plus"],
  Compasal: ["compasal"],
  Onyx: ["onyx"],
  Fullrun: ["fullrun", "full run"],
  Antyre: ["antyre"],
  Blacklion: ["blacklion", "black lion"],
  Greenland: ["greenland"],
  Supercargo: ["supercargo", "super cargo"],
  Torque: ["torque"],
  Nankang: ["nankang"],
  Kenda: ["kenda"],
  Federal: ["federal"],
  Vredestein: ["vredestein"],
  Nokian: ["nokian"],
  Matador: ["matador"],
  Barum: ["barum"],
  Semperit: ["semperit"],
  Uniroyal: ["uniroyal"],
  Kelly: ["kelly"],
  Dayton: ["dayton"],
  Fate: ["fate"],
  Tornel: ["tornel"],
  Euzkadi: ["euzkadi"],
  "Lima Caucho": ["lima caucho", "limacaucho"],
  // brands seen in the client's own list, Odoo stock and provider lists (Peru)
  Fenixway: ["fenixway", "fenix way", "fenix-way", "fenix"],
  Aonaite: ["aonaite", "aonite", "aonaite tyres"],
  Terrex: ["terrex", "tereex", "teerex"],
  Tesche: ["tesche"],
  Marshal: ["marshal"],
  "City Walker": ["city walker", "citywalker"],
  Hifly: ["hifly", "hi-fly", "hi fly"],
  Sunfull: ["sunfull", "sun full"],
  Worcraft: ["worcraft"],
  Runstone: ["runstone"],
  Forlander: ["forlander"],
  Winda: ["winda"],
  Zowin: ["zowin"],
  Addo: ["addo"],
  Taifa: ["taifa"],
  Braza: ["braza"],
  MRL: ["mrl"],
  Amberstone: ["amberstone"],
  Wonderland: ["wonderland"],
  Advance: ["advance"],
  Farroad: ["farroad", "arcron"],
  Sunny: ["sunny"],
  Bansol: ["bansol"],
  Vipal: ["vipal"],
  Sika: ["sika"],
  Firemax: ["firemax"],
  "Track King": ["track king", "trackking"],
  Agate: ["agate"],
  Vikrant: ["vikrant"],
  Birla: ["birla"],
  MRF: ["mrf"],
  Samson: ["samson"],
  Galaxy: ["galaxy"],
  Alliance: ["alliance"],
  Titan: ["titan"],
  Carlisle: ["carlisle"],
  Speedways: ["speedways"],
  Malhotra: ["malhotra"],
  Starmaxx: ["starmaxx"],
  Petlas: ["petlas"],
  Ozka: ["ozka"],
  Mitas: ["mitas"],
  Trelleborg: ["trelleborg"],
  Cultor: ["cultor"],
  Armour: ["armour"],
  Roadguider: ["roadguider"],
  Superguider: ["superguider"],
  Duraturn: ["duraturn"],
  Crosswind: ["crosswind"],
  Landsail: ["landsail"],
  Sportrak: ["sportrak"],
  Haida: ["haida"],
  Joyroad: ["joyroad"],
  Grenlander: ["grenlander"],
  Roadcruza: ["roadcruza"],
  Sunwide: ["sunwide"],
  Evergreen: ["evergreen"],
  Nama: ["nama"],
  Dynamo: ["dynamo"],
  Techking: ["techking", "tech king"],
};

const ALIAS_INDEX: Map<string, string> = new Map();
for (const [canonical, aliases] of Object.entries(BRANDS)) {
  ALIAS_INDEX.set(fold(canonical), canonical);
  for (const a of aliases) ALIAS_INDEX.set(fold(a), canonical);
}

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(" ");
}

/** Known brand for a cell/token, or null if it is not a brand we know. */
export function knownBrand(s: string): string | null {
  const f = fold(s);
  if (!f) return null;
  return ALIAS_INDEX.get(f) ?? null;
}

/** Normalize a brand string (known -> canonical spelling; unknown -> Title Case). */
export function normalizeBrand(s: string | null | undefined): string {
  if (!s) return "";
  return knownBrand(s) ?? titleCase(s.trim());
}

/** Find a known brand mentioned anywhere in free text (longest alias wins). Returns [brand, alias]. */
export function findBrandInText(text: string): { brand: string; alias: string; index: number } | null {
  const f = ` ${fold(text)} `;
  let best: { brand: string; alias: string; index: number } | null = null;
  for (const [alias, brand] of ALIAS_INDEX) {
    if (alias.length < 2) continue;
    const idx = f.indexOf(` ${alias} `);
    if (idx === -1) continue;
    if (!best || alias.length > best.alias.length) best = { brand, alias, index: idx };
  }
  return best;
}

export const KNOWN_BRANDS = Object.keys(BRANDS);
