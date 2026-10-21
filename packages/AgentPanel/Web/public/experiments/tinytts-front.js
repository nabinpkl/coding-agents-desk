// Experiment support for `local-test.html`, not part of the panel: TinyTTS's text front
// end (text to phoneme ids), copied from its npm package (tiny-tts@5.0.1, index.js, Apache-2.0,
// https://github.com/tronghieuit/tiny-tts) with the Node parts taken out. The CMU dictionary is
// handed in by the page; the package's neural fallback for unknown words is left out, so a word
// missing from the dictionary is spelled letter by letter.
(function () {
// ===========================================================================
// Symbol table — EXACT copy of Python tiny_tts/text/symbols.py (219 symbols)
// ===========================================================================
const SYMBOLS = ["_","\"","(",")","*","/",":","AA","E","EE","En","N","OO","Q","V","[","\\","]","^","a","a:","aa","ae","ah","ai","an","ang","ao","aw","ay","b","by","c","ch","d","dh","dy","e","e:","eh","ei","en","eng","er","ey","f","g","gy","h","hh","hy","i","i0","i:","ia","ian","iang","iao","ie","ih","in","ing","iong","ir","iu","iy","j","jh","k","ky","l","m","my","n","ng","ny","o","o:","ong","ou","ow","oy","p","py","q","r","ry","s","sh","t","th","ts","ty","u","u:","ua","uai","uan","uang","uh","ui","un","uo","uw","v","van","ve","vn","w","x","y","z","zh","zy","~","\u00e6","\u00e7","\u00f0","\u00f8","\u014b","\u0153","\u0250","\u0251","\u0252","\u0254","\u0255","\u0259","\u025b","\u025c","\u0261","\u0263","\u0265","\u0266","\u026a","\u026b","\u026c","\u026d","\u026f","\u0272","\u0275","\u0278","\u0279","\u027e","\u0281","\u0283","\u028a","\u028c","\u028e","\u028f","\u0291","\u0292","\u029d","\u02b2","\u02c8","\u02cc","\u02d0","\u0303","\u0329","\u03b2","\u03b8","\u1100","\u1101","\u1102","\u1103","\u1104","\u1105","\u1106","\u1107","\u1108","\u1109","\u110a","\u110b","\u110c","\u110d","\u110e","\u110f","\u1110","\u1111","\u1112","\u1161","\u1162","\u1163","\u1164","\u1165","\u1166","\u1167","\u1168","\u1169","\u116a","\u116b","\u116c","\u116d","\u116e","\u116f","\u1170","\u1171","\u1172","\u1173","\u1174","\u1175","\u11a8","\u11ab","\u11ae","\u11af","\u11b7","\u11b8","\u11bc","\u3138","!","?","\u2026",",",".","'","-","\u00bf","\u00a1","SP","UNK"];
const SYM = {};
for (let i = 0; i < SYMBOLS.length; i++) SYM[SYMBOLS[i]] = i;

const LANG_ID = 2;
const TONE_OFFSET = 7;
const SAMPLE_RATE = 44100;

// ===========================================================================
// CMU Pronouncing Dictionary — full 112K entries loaded from cmudict.json
// ===========================================================================
let CMU = {};

// ===========================================================================
// G2P Pipeline — matches Python tiny_tts/text/english.py EXACTLY
// ===========================================================================

function _parsePhone(phn) {
  const m = phn.match(/(\d)$/);
  if (m) return [phn.slice(0,-1).toLowerCase(), parseInt(m[1])+1];
  return [phn.toLowerCase(), 0];
}

function _parseSyllables(syllables) {
  const phones=[], tones=[];
  for (const syl of syllables) {
    for (const phn of syl) {
      const [ph, tone] = _parsePhone(phn);
      phones.push(ph); tones.push(tone);
    }
  }
  return [phones, tones];
}

function _mapPhoneme(ph) {
  const rep = {'\uFF1A':',','\uFF1B':',','\uFF0C':',','\u3002':'.',
    '\uFF01':'!','\uFF1F':'?','\n':'.','\xB7':',',
    '\u3001':',','...':'\u2026','v':'V'};
  if (rep[ph] !== undefined) return rep[ph];
  if (SYM[ph] !== undefined) return ph;
  return 'UNK';
}

/**
 * Grapheme to phoneme — simplified version matching Python pipeline.
 * 1. Lowercase
 * 2. Split into words
 * 3. Strip punctuation from each word
 * 4. Look up in CMU dict
 * 5. Fallback: char-level for unknown words
 * 6. Map phonemes, pad with '_'
 */
function graphemeToPhoneme(text) {
  text = text.toLowerCase().trim();
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const allPhones=[], allTones=[], word2ph=[];

  for (const word of words) {
    // Separate leading/trailing punctuation
    const lead = word.match(/^[^a-z0-9]*/)[0] || '';
    const trail = word.match(/[^a-z0-9']*$/)[0] || '';
    const core = word.slice(lead.length, word.length - trail.length);

    // Leading punctuation
    for (const ch of lead) {
      const m = _mapPhoneme(ch);
      allPhones.push(m); allTones.push(0); word2ph.push(1);
    }

    // Core word
    if (core.length > 0) {
      let resolved = false;
      // Always split on apostrophe first (matches Python BERT tokenizer behavior)
      // BERT treats "'" as a separate token: "don't" -> ["don", "'", "t"]
      if (core.includes("'")) {
          const parts = core.split("'");
          let allPartPhones = [], allPartTones = [];
          let allFound = true;
          for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi];
            // Insert apostrophe phoneme between parts (matches Python BERT behavior)
            if (pi > 0) {
              allPartPhones.push("'");
              allPartTones.push(0);
            }
            if (part.length === 0) continue;
            const pUpper = part.toUpperCase();
            if (CMU[pUpper]) {
              const [ph, tn] = _parseSyllables([CMU[pUpper]]);
              allPartPhones.push(...ph);
              allPartTones.push(...tn);
            } else {
              // Use neural G2P for unknown parts (short or long)
              const partPreds = null;
              if (partPreds && partPreds.length > 0) {
                for (const phn of partPreds) {
                  const [ph2, tn2] = _parsePhone(phn);
                  allPartPhones.push(ph2);
                  allPartTones.push(tn2);
                }
              } else {
                allFound = false;
                break;
              }
            }
          }
          if (allFound && allPartPhones.length > 0) {
            for (const p of allPartPhones) allPhones.push(_mapPhoneme(p));
            allTones.push(...allPartTones);
            word2ph.push(allPartPhones.length);
            resolved = true;
          }
        }
        // CMU dictionary lookup (for words without apostrophe)
        if (!resolved) {
          const upper = core.toUpperCase();
          if (CMU[upper]) {
            const [phones, tones] = _parseSyllables([CMU[upper]]);
            for (const p of phones) allPhones.push(_mapPhoneme(p));
            allTones.push(...tones);
            word2ph.push(phones.length);
            resolved = true;
          }
        }
        // Neural G2P fallback (matches Python g2p_en exactly)
        if (!resolved) {
          const neuralPreds = null;
          if (neuralPreds && neuralPreds.length > 0) {
            const [ph, tn] = _parseSyllables([neuralPreds]);
            for (const p of ph) allPhones.push(_mapPhoneme(p));
            allTones.push(...tn);
            word2ph.push(ph.length);
          } else {
            // Ultimate fallback: character-level
            for (const ch of core) {
              if (ch === "'") continue;
              allPhones.push(ch.toLowerCase());
              allTones.push(0);
            }
            word2ph.push(core.replace(/'/g, '').length);
          }
        }
    }

    // Trailing punctuation
    for (const ch of trail) {
      const m = _mapPhoneme(ch);
      allPhones.push(m); allTones.push(0); word2ph.push(1);
    }
  }

  // Pad start and end (matches Python's pad_start_end=True)
  allPhones.unshift('_'); allPhones.push('_');
  allTones.unshift(0); allTones.push(0);
  word2ph.unshift(1); word2ph.push(1);

  return { phones: allPhones, tones: allTones, word2ph };
}

function phonemesToIds(phones, tones) {
  const phoneIds = phones.map(p => SYM[p] !== undefined ? SYM[p] : SYM['UNK']);
  const toneIds = tones.map(t => t + TONE_OFFSET);
  const langIds = new Array(phoneIds.length).fill(LANG_ID);
  return [phoneIds, toneIds, langIds];
}

/**
 * Full pipeline: text → phoneme IDs with blank insertion
 * Matches Python: commons.insert_blanks(ids, 0)
 *   result = [0] * (len(ids) * 2 + 1)
 *   result[1::2] = ids
 */
function textToPhonemeIds(text) {
  const { phones, tones } = graphemeToPhoneme(text);
  const [phoneIds, toneIds, langIds] = phonemesToIds(phones, tones);

  // Insert blanks matching Python's insert_blanks
  const n = phoneIds.length;
  const pb = new Array(n * 2 + 1).fill(0);
  const tb = new Array(n * 2 + 1).fill(0);
  const lb = new Array(n * 2 + 1).fill(0);
  for (let i = 0; i < n; i++) {
    pb[1 + i * 2] = phoneIds[i];
    tb[1 + i * 2] = toneIds[i];
    lb[1 + i * 2] = langIds[i];
  }
  return { phoneIds: pb, toneIds: tb, langIds: lb };
}


  window.TinyTTSFront = {
    SAMPLE_RATE,
    setDictionary(dictionary) {
      CMU = dictionary;
    },
    textToPhonemeIds,
  };
})();
