"use strict";

const APP_VERSION = "5.19";
const KEYS = { lavori: "todo_lavori", articoli: "todo_articoli", movimenti: "todo_movimenti", impianti: "todo_impianti", coda: "todo_coda", impegni: "todo_impegni", catalogo: "todo_catalogo", preventivi: "todo_preventivi" };

// ============ SINCRONIZZAZIONE FIREBASE (Firestore + Storage) ============
// Sostituisce il vecchio storage locale/Drive: ogni collezione (lavori, impianti, ecc.)
// vive su Firestore e si aggiorna in tempo reale su tutti i dispositivi collegati
// con lo stesso account. Le foto (base64) vengono caricate su Storage e nel
// documento resta solo il link, per non sforare il limite di 1MB per documento.
const remoteCache = {};
let realtimeAvviato = false;

function avviaSincronizzazioneRealtime() {
  if (realtimeAvviato) return;
  realtimeAvviato = true;
  Object.entries(KEYS).forEach(([prop, coll]) => {
    db.collection(coll).onSnapshot((snap) => {
      let arr = snap.docs.map((d) => d.data());
      if (prop === "coda") arr = arr.slice().sort((a, b) => (a.ordine ?? 0) - (b.ordine ?? 0));
      state[prop] = arr;
      remoteCache[coll] = JSON.parse(JSON.stringify(arr)); // copia indipendente: l'app modifica state[prop] "sul posto",
      // se remoteCache puntasse allo stesso array quelle modifiche sparirebbero anche da qui, e il confronto con
      // Firestore non vedrebbe più nessuna differenza da salvare
      render();
    }, (err) => {
      console.error(err);
      state.syncError = "Sincronizzazione non riuscita: " + err.message;
      render();
    });
  });
}

async function convertiFotoRicorsivo(valore, coll, idItem, contatore) {
  if (Array.isArray(valore)) {
    for (let i = 0; i < valore.length; i++) valore[i] = await convertiFotoRicorsivo(valore[i], coll, idItem, contatore);
    return valore;
  }
  if (valore && typeof valore === "object") {
    for (const k of Object.keys(valore)) valore[k] = await convertiFotoRicorsivo(valore[k], coll, idItem, contatore);
    return valore;
  }
  if (typeof valore === "string" && valore.indexOf("data:image") === 0) {
    contatore.n++;
    const percorso = `foto/${coll}/${idItem}_${Date.now()}_${contatore.n}.jpg`;
    const ref = storage.ref().child(percorso);
    await ref.putString(valore, "data_url");
    return await ref.getDownloadURL();
  }
  return valore;
}

async function pushToFirestore(coll, arr) {
  const prev = remoteCache[coll] || [];
  const prevMap = new Map(prev.filter((it) => it && it.id != null).map((it) => [String(it.id), it]));
  const attuali = arr.filter((it) => it && it.id != null);
  const nowIds = new Set(attuali.map((it) => String(it.id)));
  const batch = db.batch();
  let modifiche = 0;
  for (const item of attuali) {
    const id = String(item.id);
    const precedente = prevMap.get(id);
    if (precedente && JSON.stringify(precedente) === JSON.stringify(item)) continue;
    const clone = JSON.parse(JSON.stringify(item));
    await convertiFotoRicorsivo(clone, coll, id, { n: 0 });
    batch.set(db.collection(coll).doc(id), clone);
    modifiche++;
  }
  prevMap.forEach((_, id) => { if (!nowIds.has(id)) { batch.delete(db.collection(coll).doc(id)); modifiche++; } });
  if (modifiche > 0) await batch.commit();
}

function saveArr(key, arr) {
  segnaUltimaModifica();
  pushToFirestore(key, arr).catch((err) => {
    console.error(err);
    state.syncError = "Sincronizzazione non riuscita: " + err.message;
    render();
  });
}

function getDeviceLabel() {
  let lbl = localStorage.getItem("todo_device_label");
  if (!lbl) {
    lbl = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Cellulare" : "PC";
    localStorage.setItem("todo_device_label", lbl);
  }
  return lbl;
}
function segnaUltimaModifica() {
  localStorage.setItem("todo_last_edit", JSON.stringify({ ts: Date.now(), device: getDeviceLabel() }));
}

const state = {
  tab: (() => {
    const params = new URLSearchParams(location.search);
    const t = params.get("tab");
    return ["lavori", "coda", "magazzino", "impianti", "cassa", "impegni", "preventivi"].includes(t) ? t : "lavori";
  })(),
  lavori: [], articoli: [], movimenti: [], impianti: [], coda: [], impegni: [], catalogo: [], preventivi: [],
  // popolati in tempo reale da Firestore dopo il login, vedi avviaSincronizzazioneRealtime()

  authUser: null, authLoading: true, authError: "", syncError: "",

  viewPreventivi: "lista", subPreventivi: "elenco", // elenco | catalogo
  queryCatalogo: "", formArticoloCatalogo: null,
  formPreventivo: null, detailPreventivo: null,
  showPreview: false, previewType: null, previewData: null,

  viewImpegni: "lista", queryImpegni: "",
  formImpegno: null,

  viewLavori: "lista", filterLavori: "tutti", queryLavori: "",
  formLavoro: null, // object being edited, or {} for new
  detailLavoro: null,

  viewMagazzino: "lista", queryMagazzino: "",
  formArticolo: null, isCorrezione: false,

  viewImpianti: "lista", queryImpianti: "", filterImpianti: "tutti",
  formImpianto: null,

  viewCassa: "lista",
  formMovimento: null,

  showSettings: false,
  backupMsg: "",
  restoring: false,
};

function uid() { return `${Date.now()}${Math.floor(Math.random() * 1000)}`; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtData(iso) { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function fmtUltimaModifica() {
  try {
    const raw = localStorage.getItem("todo_last_edit");
    if (!raw) return "";
    const { ts, device } = JSON.parse(raw);
    const d = new Date(ts);
    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    const giornoModifica = new Date(ts); giornoModifica.setHours(0, 0, 0, 0);
    const diffGiorni = Math.round((oggi - giornoModifica) / 86400000);
    const ora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    let quando;
    if (diffGiorni === 0) quando = `oggi alle ${ora}`;
    else if (diffGiorni === 1) quando = `ieri alle ${ora}`;
    else quando = `${fmtData(d.toISOString().slice(0, 10))} alle ${ora}`;
    return `Ultima modifica: ${esc(device)} · ${quando}`;
  } catch (e) { return ""; }
}
function itToIso(itDate) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((itDate || "").trim());
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ---------- import CSV ----------
function normalizeHeader(h) {
  return (h || "").toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}
const CSV_ALIASES = {
  numeroIntervento: ["numero", "numerointervento", "nintervento", "n", "numint", "n"],
  cliente: ["cliente", "nomecliente", "clientenome"],
  descrizione: ["descrizione", "lavoro", "descrizionelavoro", "intervento"],
  data: ["data", "dataintervento"],
  telefono: ["telefono", "tel", "cellulare"],
  importo: ["importo", "totale", "prezzo"],
  statoPagamento: ["stato", "pagamento", "statopagamento"],
  acconto: ["acconto"],
  inGaranzia: ["garanzia", "ingaranzia"],
  garanziaScadenza: ["scadenzagaranzia", "garanziascadenza", "datascadenzagaranzia"],
  remoto: ["remoto", "daremoto"],
  note: ["note", "nota"],
};
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  function splitLine(line) {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === delim && !inQ) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  const headers = splitLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ""; });
    return row;
  });
}
function csvGet(row, field) {
  for (const alias of CSV_ALIASES[field]) {
    if (row[alias] !== undefined && row[alias] !== "" && row[alias] !== null) return row[alias];
  }
  return "";
}
function isSiVero(v) { return ["si", "sì", "x", "1", "true", "vero"].includes(String(v || "").toLowerCase().trim()); }
function anyDateToIso(v) {
  if (!v) return "";
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return itToIso(s);
}
function mapCsvRow(row) {
  const remoto = isSiVero(csvGet(row, "remoto"));
  const inGaranzia = isSiVero(csvGet(row, "inGaranzia"));
  const senzaPagamento = remoto || inGaranzia;
  const statoRaw = String(csvGet(row, "statoPagamento") || "").toLowerCase();
  let stato = "da_pagare";
  if (statoRaw.includes("pagat")) stato = "pagato";
  else if (statoRaw.includes("acconto")) stato = "acconto";
  return {
    id: uid(),
    numeroIntervento: String(csvGet(row, "numeroIntervento") || "").trim(),
    cliente: String(csvGet(row, "cliente") || "").trim(),
    telefono: String(csvGet(row, "telefono") || "").trim(),
    descrizione: String(csvGet(row, "descrizione") || "").trim(),
    data: anyDateToIso(csvGet(row, "data")) || oggi(),
    remoto,
    importo: senzaPagamento ? "" : String(csvGet(row, "importo") || ""),
    statoPagamento: senzaPagamento ? "" : stato,
    acconto: senzaPagamento ? "" : String(csvGet(row, "acconto") || ""),
    materiali: [],
    foto: [],
    inGaranzia,
    garanziaScadenza: inGaranzia ? anyDateToIso(csvGet(row, "garanziaScadenza")) : "",
    note: String(csvGet(row, "note") || "").trim(),
  };
}
function rinumeraLavoriPerAnno() {
  if (!confirm("Rinumerare tutti i lavori, ricominciando da 001 per ogni anno? L'ordine cronologico resta invariato, cambiano solo i numeri.")) return;
  const sorted = [...state.lavori].sort((a, b) => {
    const ay = (a.data || "").slice(0, 4), by = (b.data || "").slice(0, 4);
    if (ay !== by) return ay.localeCompare(by);
    return (a.data || "").localeCompare(b.data || "");
  });
  const contatori = {};
  sorted.forEach((j) => {
    const anno = (j.data || "").slice(0, 4) || String(new Date().getFullYear());
    contatori[anno] = (contatori[anno] || 0) + 1;
    j.numeroIntervento = `${String(contatori[anno]).padStart(3, "0")}-${anno}`;
  });
  state.lavori = sorted.sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  saveArr(KEYS.lavori, state.lavori);
  state.backupMsg = "Numerazione ricalcolata: un anno alla volta, da 001.";
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 4000);
}

function importaRighe(rows) {
  let importati = 0;
  rows.forEach((row) => {
    const job = mapCsvRow(row);
    if (!job.cliente && !job.descrizione) return;
    if (!job.numeroIntervento) job.numeroIntervento = prossimoNumeroIntervento(Number((job.data || "").slice(0, 4)) || undefined);
    state.lavori.push(job);
    importati++;
  });
  state.lavori.sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  saveArr(KEYS.lavori, state.lavori);
  if (importati === 0) {
    const msg = `Lette ${rows.length} righe ma nessuna aveva un cliente o una descrizione valorizzati.`;
    state.backupMsg = msg;
    alert(msg);
  } else {
    state.backupMsg = `Importati ${importati} interventi.`;
  }
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 4000);
}
function anyDateToItText(v) {
  if (!v) return "";
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${d}/${m}/${y}`;
  }
  const s = String(v).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtData(s);
  return s;
}
const CSV_ALIASES_IMPIANTO = {
  numeroImpianto: ["numero", "numeroimpianto", "nimpianto", "n"],
  dataImpianto: ["data", "dataimpianto"],
  nome: ["nome", "cliente", "nomeimpianto"],
  tipoCentrale: ["tipocentrale", "centrale", "tipo"],
  numeroTelefonico: ["numerotelefonico", "telefono", "tel", "numerosim"],
  note: ["note", "nota"],
};
function csvGetGeneric(row, aliases) {
  for (const alias of aliases) if (row[alias] !== undefined && row[alias] !== "" && row[alias] !== null) return row[alias];
  return "";
}
function mapCsvRowImpianto(row) {
  return {
    id: uid(),
    numeroImpianto: String(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.numeroImpianto) || "").trim(),
    dataImpianto: anyDateToItText(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.dataImpianto)) || fmtData(oggi()),
    nome: String(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.nome) || "").trim(),
    tipoCentrale: String(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.tipoCentrale) || "").trim(),
    numeroTelefonico: String(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.numeroTelefonico) || "").trim(),
    note: String(csvGetGeneric(row, CSV_ALIASES_IMPIANTO.note) || "").trim(),
  };
}
function importaRigheImpianti(rows) {
  let importati = 0;
  rows.forEach((row) => {
    const imp = mapCsvRowImpianto(row);
    if (!imp.nome) return;
    state.impianti.push(imp);
    importati++;
  });
  saveArr(KEYS.impianti, state.impianti);
  state.backupMsg = `Importati ${importati} impianti.`;
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 4000);
}
const CSV_ALIASES_CATALOGO = {
  codice: ["codice", "cod", "codicearticolo"],
  nome: ["nome", "descrizione", "descrizionemateriale", "articolo"],
  costoUnitario: ["costounitario", "costoun", "costo", "prezzo", "prezzounitario"],
};
function mapCsvRowCatalogo(row) {
  return {
    id: uid(),
    codice: String(csvGetGeneric(row, CSV_ALIASES_CATALOGO.codice) || "").trim(),
    nome: String(csvGetGeneric(row, CSV_ALIASES_CATALOGO.nome) || "").trim(),
    costoUnitario: String(csvGetGeneric(row, CSV_ALIASES_CATALOGO.costoUnitario) || "").trim(),
    foto: "",
  };
}
function importaRigheCatalogoDirette(righe) {
  let importati = 0;
  righe.forEach((r) => {
    const nome = String(r.nome || "").trim();
    if (!nome) return;
    state.catalogo.push({
      id: uid(),
      codice: String(r.codice || "").trim(),
      nome,
      costoUnitario: r.costoUnitario != null ? String(r.costoUnitario) : "",
      foto: "",
    });
    importati++;
  });
  saveArr(KEYS.catalogo, state.catalogo);
  state.backupMsg = `Importati ${importati} articoli nel catalogo (lettura per colonna).`;
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 4000);
}

function importaRigheCatalogo(rows) {
  let importati = 0;
  rows.forEach((row) => {
    const art = mapCsvRowCatalogo(row);
    if (!art.nome) return;
    state.catalogo.push(art);
    importati++;
  });
  saveArr(KEYS.catalogo, state.catalogo);
  state.backupMsg = `Importati ${importati} articoli nel catalogo.`;
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 4000);
}
function importaCatalogoFile(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    if (typeof XLSX === "undefined") { alert("Libreria Excel non disponibile: assicurati di avere connessione internet e riprova."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        // formato tipico listino fornitore, anche senza intestazioni complete: A=codice, B=descrizione, D=costo unitario
        const righePosizionali = aoa
          .filter((r) => r[1] && String(r[1]).trim() && typeof r[3] === "number")
          .map((r) => ({ codice: r[0], nome: r[1], costoUnitario: r[3] }));

        if (righePosizionali.length >= 3) {
          importaRigheCatalogoDirette(righePosizionali);
        } else {
          const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
          const rows = raw.map((obj) => {
            const row = {};
            Object.keys(obj).forEach((k) => { row[normalizeHeader(k)] = obj[k]; });
            return row;
          });
          if (rows.filter((r) => mapCsvRowCatalogo(r).nome).length > 0) {
            importaRigheCatalogo(rows);
          } else {
            alert("Non riesco a riconoscere le colonne di questo file. Prova a controllare le intestazioni (codice, descrizione, costo).");
          }
        }
      } catch (e) { console.error(e); alert("Errore nella lettura del file Excel."); }
    };
    reader.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try { importaRigheCatalogo(parseCSV(reader.result)); }
    catch (e) { console.error(e); alert("Errore nella lettura del CSV."); }
  };
  reader.readAsText(file, "UTF-8");
}

function importaImpiantiFile(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    if (typeof XLSX === "undefined") { state.backupMsg = "Libreria Excel non disponibile offline al primo avvio: riprova con connessione attiva."; render(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const rows = raw.map((obj) => {
          const row = {};
          Object.keys(obj).forEach((k) => { row[normalizeHeader(k)] = obj[k]; });
          return row;
        });
        importaRigheImpianti(rows);
      } catch (e) {
        console.error(e);
        state.backupMsg = "Errore nella lettura del file Excel.";
        render();
      }
    };
    reader.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try { importaRigheImpianti(parseCSV(reader.result)); }
    catch (e) { console.error(e); state.backupMsg = "Errore nella lettura del CSV."; render(); }
  };
  reader.readAsText(file, "UTF-8");
}

function apriPreview(tipo, p) {
  state.previewType = tipo;
  state.previewData = p;
  state.showPreview = true;
  render();
}

function renderPreviewOverlay() {
  const p = state.previewData;
  if (!p) return "";
  if (state.previewType === "excel") {
    const tutteVoci = p.voci || [];
    const sepIdx = tutteVoci.findIndex((v) => v.separatore);
    const vociToRiga = (v) => {
      const art = state.catalogo.find((a) => a.nome.toLowerCase() === v.nome.toLowerCase());
      const costoUn = art ? Number(art.costoUnitario) || 0 : 0;
      const qty = Number(v.quantita) || 0;
      return { codice: art ? art.codice : "", nome: v.nome, ubicazione: v.ubicazione || "", qty, costoUn, tot: costoUn * qty };
    };
    const righe = (sepIdx === -1 ? tutteVoci : tutteVoci.slice(0, sepIdx)).map(vociToRiga);
    const righeAggiunte = sepIdx === -1 ? [] : tutteVoci.slice(sepIdx + 1).map(vociToRiga);
    const totaleCosti = righe.reduce((s, r) => s + r.tot, 0);
    const margine = (Number(p.totale) || 0) - totaleCosti;
    const totaleCostiAggiunte = righeAggiunte.reduce((s, r) => s + r.tot, 0);
    const margineAggiunte = (Number(p.totaleAggiunte) || 0) - totaleCostiAggiunte;
    const tabella = (rows) => `
            <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
              <thead><tr style="background:var(--paper);"><th style="text-align:left;padding:6px 8px;">Prodotto</th><th style="text-align:right;padding:6px 8px;">Qt&agrave;</th><th style="text-align:right;padding:6px 8px;">Costo un.</th><th style="text-align:right;padding:6px 8px;">Totale</th></tr></thead>
              <tbody>
                ${rows.map((r) => `<tr style="border-top:1px solid var(--border);"><td style="padding:6px 8px;">${esc(r.nome)}</td><td style="text-align:right;padding:6px 8px;">${r.qty}</td><td style="text-align:right;padding:6px 8px;">&euro;${euro(r.costoUn)}</td><td style="text-align:right;padding:6px 8px;">&euro;${euro(r.tot)}</td></tr>`).join("")}
              </tbody>
            </table>`;
    return `
      <div class="overlay" data-action="close-preview">
        <div class="sheet" data-stop data-action="noop" style="max-width:520px;">
          <div class="sheet-head"><h3>Anteprima Excel costi</h3><button class="sheet-close" data-action="close-preview">&#10005;</button></div>
          <div style="max-height:50vh;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-bottom:12px;">
            ${tabella(righe)}
          </div>
          <p style="font-size:13px;margin:4px 0;">Totale costi: <strong>&euro;${euro(totaleCosti)}</strong></p>
          ${p.totale ? `<p style="font-size:13px;margin:4px 0;">Prezzo cliente: <strong>&euro;${euro(p.totale)}</strong></p><p style="font-size:13px;margin:4px 0;">Margine: <strong>&euro;${euro(margine)}</strong></p>` : ""}
          ${sepIdx === -1 ? "" : `
          <div style="border-top:2px dashed var(--ink);margin:14px 0 10px;padding-top:10px;">
            <p style="font-size:13px;font-weight:800;margin:0 0 8px;">&#9986;&#65039; Aggiunte facoltative</p>
            <div style="max-height:30vh;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;">
              ${tabella(righeAggiunte)}
            </div>
            <p style="font-size:13px;margin:4px 0;">Totale costi aggiunte: <strong>&euro;${euro(totaleCostiAggiunte)}</strong></p>
            ${p.totaleAggiunte ? `<p style="font-size:13px;margin:4px 0;">Prezzo aggiunte: <strong>&euro;${euro(p.totaleAggiunte)}</strong></p><p style="font-size:13px;margin:4px 0;">Margine aggiunte: <strong>&euro;${euro(margineAggiunte)}</strong></p>` : ""}
          </div>`}
          <button class="btn-primary" style="width:100%;margin-top:12px;" data-action="confirm-download-excel">Scarica Excel</button>
        </div>
      </div>`;
  }
  // anteprima PDF
  const sepIdxPdf = (p.voci || []).findIndex((v) => v.separatore);
  const vociPrincipaliPdf = sepIdxPdf === -1 ? (p.voci || []) : (p.voci || []).slice(0, sepIdxPdf);
  const vociAggiuntePdf = sepIdxPdf === -1 ? [] : (p.voci || []).slice(sepIdxPdf + 1);
  const rigaVocePdf = (v) => `
            <div style="display:flex;gap:10px;margin-top:10px;align-items:flex-start;">
              ${v.foto ? `<img src="${v.foto}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #ddd;flex-shrink:0;" />` : ""}
              <div style="flex:1;">
                <p style="font-size:13px;font-weight:700;margin:0;display:flex;justify-content:space-between;gap:8px;"><span>${esc(v.nome)}</span><span>${esc(v.quantita)}</span></p>
                ${v.descrizione ? `<p style="font-size:11px;opacity:.75;margin:2px 0 0;">${esc(v.descrizione)}</p>` : ""}
                ${v.ubicazione ? `<p style="font-size:11px;opacity:.6;margin:1px 0 0;font-style:italic;">Cos&igrave; ubicati: ${esc(v.ubicazione)}</p>` : ""}
              </div>
            </div>`;
  return `
    <div class="overlay" data-action="close-preview">
      <div class="sheet" data-stop data-action="noop" style="max-width:520px;">
        <div class="sheet-head"><h3>Anteprima PDF</h3><button class="sheet-close" data-action="close-preview">&#10005;</button></div>
        <div style="max-height:55vh;overflow-y:auto;background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;color:#111;">
          <p style="font-weight:800;font-size:15px;margin:0 0 4px;">Preventivo — ${esc(p.clienteNome)}</p>
          ${p.clienteIndirizzo ? `<p style="font-size:12px;margin:0 0 4px;">${esc(p.clienteIndirizzo)}</p>` : ""}
          ${p.testoIntro ? `<p style="font-size:12px;line-height:1.5;margin:0 0 10px;white-space:pre-wrap;">${esc(p.testoIntro)}</p>` : ""}
          ${vociPrincipaliPdf.map(rigaVocePdf).join("")}
          <hr style="margin:14px 0;border:none;border-top:1px solid #ddd;" />
          <p style="font-size:16px;font-weight:900;text-align:right;">TOTALE &euro; ${euro(p.totale)}</p>
          ${vociAggiuntePdf.length === 0 ? "" : `
          <div style="border-top:2px dashed #111;margin-top:14px;padding-top:10px;">
            <p style="font-size:12px;font-weight:700;font-style:italic;margin:0 0 4px;">Aggiunte facoltative — a scelta del cliente:</p>
            ${vociAggiuntePdf.map(rigaVocePdf).join("")}
            <hr style="margin:14px 0;border:none;border-top:1px solid #ddd;" />
            <p style="font-size:16px;font-weight:900;text-align:right;">TOTALE AGGIUNTE &euro; ${euro(p.totaleAggiunte)}</p>
          </div>`}
        </div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn-primary" style="flex:1;" data-action="confirm-download-pdf">Scarica PDF</button>
          <button class="btn-whatsapp" style="flex:1;margin-top:0;" data-action="invia-pdf-whatsapp">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="#25D366"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39c1.45.79 3.08 1.21 4.75 1.21h.004c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0012.04 2m0 1.67a8.2 8.2 0 018.24 8.24c0 4.55-3.7 8.25-8.25 8.25a8.2 8.2 0 01-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 01-1.26-4.38c0-4.55 3.7-8.25 8.25-8.25M8.53 6.7c-.16 0-.43.06-.66.31-.22.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.13.17 1.75 2.8 4.32 3.82 2.14.85 2.57.68 3.04.64.46-.04 1.5-.61 1.71-1.2.21-.59.21-1.09.15-1.2-.06-.11-.23-.17-.48-.3-.25-.13-1.5-.74-1.73-.82-.23-.09-.4-.13-.57.13-.17.25-.65.82-.8.99-.15.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.44.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.42-.79-1.94-.2-.48-.41-.42-.57-.43z"/></svg>
            WhatsApp
          </button>
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:8px;" data-action="invia-pdf-email">&#9993;&#65039; Invia via Email</button>
      </div>
    </div>`;
}

function esportaExcelCosti(p) {
  if (typeof XLSX === "undefined") { alert("Libreria Excel non disponibile: assicurati di avere connessione internet e riprova."); return; }
  const tutteVoci = (p.voci || []).filter((v) => !v.separatore);
  const sepIdx = (p.voci || []).findIndex((v) => v.separatore);
  const vociToRow = (v) => {
    const art = state.catalogo.find((a) => a.nome.toLowerCase() === v.nome.toLowerCase());
    const costoUn = art ? Number(art.costoUnitario) || 0 : 0;
    const qty = Number(v.quantita) || 0;
    return {
      "Codice": art ? art.codice : "",
      "Prodotto": v.nome,
      "Ubicazione": v.ubicazione || "",
      "Quantità": qty,
      "Costo unitario": costoUn,
      "Costo totale": +(costoUn * qty).toFixed(2),
    };
  };
  const vociPrincipali = sepIdx === -1 ? tutteVoci : (p.voci || []).slice(0, sepIdx).filter((v) => !v.separatore);
  const vociAggiunte = sepIdx === -1 ? [] : (p.voci || []).slice(sepIdx + 1).filter((v) => !v.separatore);

  const righe = vociPrincipali.map(vociToRow);
  const totaleCosti = righe.reduce((s, r) => s + r["Costo totale"], 0);
  righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "TOTALE COSTI", "Costo totale": +totaleCosti.toFixed(2) });
  if (p.totale) {
    righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "PREZZO CLIENTE", "Costo totale": Number(p.totale) || 0 });
    righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "MARGINE", "Costo totale": +((Number(p.totale) || 0) - totaleCosti).toFixed(2) });
  }

  if (sepIdx !== -1) {
    righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "", "Costo totale": "" });
    righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "— AGGIUNTE FACOLTATIVE —", "Costo totale": "" });
    const righeAgg = vociAggiunte.map(vociToRow);
    const totaleCostiAgg = righeAgg.reduce((s, r) => s + r["Costo totale"], 0);
    righe.push(...righeAgg);
    righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "TOTALE COSTI AGGIUNTE", "Costo totale": +totaleCostiAgg.toFixed(2) });
    if (p.totaleAggiunte) {
      righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "PREZZO AGGIUNTE", "Costo totale": Number(p.totaleAggiunte) || 0 });
      righe.push({ "Codice": "", "Prodotto": "", "Ubicazione": "", "Quantità": "", "Costo unitario": "MARGINE AGGIUNTE", "Costo totale": +((Number(p.totaleAggiunte) || 0) - totaleCostiAgg).toFixed(2) });
    }
  }

  const ws = XLSX.utils.json_to_sheet(righe);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Costi");
  XLSX.writeFile(wb, `Costi_${(p.clienteNome || "preventivo").replace(/[^a-z0-9]+/gi, "_")}_${p.numero || ""}.xlsx`);
}

function costruisciPdfPreventivo(p) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, M = 18;
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(`Preventivo — ${p.clienteNome}`, M, y);
  y += 7;
  if (p.clienteIndirizzo) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(p.clienteIndirizzo, M, y);
    y += 6;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  y += 4;

  if (p.testoIntro) {
    doc.setFontSize(10.5);
    const lines = doc.splitTextToSize(p.testoIntro, W - M * 2);
    doc.text(lines, M, y);
    y += lines.length * 5 + 6;
  }

  const disegnaVoce = (v) => {
    if (y > 250) { doc.addPage(); y = 20; }
    const startY = y;
    let textX = M;
    const imgSize = 28;
    if (v.foto) {
      try {
        doc.addImage(v.foto, "JPEG", M, y, imgSize, imgSize);
        textX = M + imgSize + 6;
      } catch (e) { /* immagine non valida, procedo senza */ }
    }
    const textW = W - M - textX;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(v.nome, textX, startY + 5);
    doc.text(String(v.quantita), W - M, startY + 5, { align: "right" });
    let ty = startY + 5;
    if (v.descrizione) {
      ty += 5.5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(60);
      const descLines = doc.splitTextToSize(v.descrizione, textW);
      doc.text(descLines, textX, ty);
      doc.setTextColor(0);
      ty += descLines.length * 4.3;
    }
    if (v.ubicazione) {
      ty += 5.5;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text(`Così ubicati: ${v.ubicazione}`, textX, ty);
      doc.setTextColor(0);
    }
    const blockH = Math.max(v.foto ? imgSize + 4 : 16, (ty - startY) + 4);
    y = startY + blockH;
  };

  const disegnaTotaleParziale = (etichetta, valore) => {
    y += 4;
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setDrawColor(200);
    doc.line(M, y, W - M, y);
    y += 9;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`${etichetta}  €  ${euro(valore)}`, W - M, y, { align: "right" });
    y += 4;
  };

  const separatoreIdx = (p.voci || []).findIndex((v) => v.separatore);
  const vociPrincipali = separatoreIdx === -1 ? (p.voci || []) : (p.voci || []).slice(0, separatoreIdx);
  const vociAggiunte = separatoreIdx === -1 ? [] : (p.voci || []).slice(separatoreIdx + 1);

  vociPrincipali.forEach(disegnaVoce);

  if (vociAggiunte.length === 0) {
    y += 6;
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setDrawColor(200);
    doc.line(M, y, W - M, y);
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(`TOTALE  €  ${euro(p.totale)}`, W - M, y, { align: "right" });
  } else {
    disegnaTotaleParziale("TOTALE", p.totale);

    y += 4;
    if (y > 255) { doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bolditalic");
    doc.setFontSize(11);
    doc.text("Aggiunte facoltative — a scelta del cliente:", M, y);
    y += 7;

    vociAggiunte.forEach(disegnaVoce);

    const totaleAggiunte = Number(p.totaleAggiunte) || 0;
    y += 4;
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setDrawColor(200);
    doc.line(M, y, W - M, y);
    y += 9;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(`TOTALE AGGIUNTE  €  ${euro(totaleAggiunte)}`, W - M, y, { align: "right" });
  }

  return doc;
}

function nomeFilePdfPreventivo(p) {
  return `Preventivo_${(p.clienteNome || "cliente").replace(/[^a-z0-9]+/gi, "_")}_${p.numero || ""}.pdf`;
}

function generaPdfPreventivo(p) {
  if (typeof window.jspdf === "undefined") {
    alert("Libreria PDF non disponibile: assicurati di avere connessione internet e riprova.");
    return;
  }
  const doc = costruisciPdfPreventivo(p);
  doc.save(nomeFilePdfPreventivo(p));
}

async function inviaPdfWhatsapp(p) {
  if (typeof window.jspdf === "undefined") {
    alert("Libreria PDF non disponibile: assicurati di avere connessione internet e riprova.");
    return;
  }
  const doc = costruisciPdfPreventivo(p);
  const filename = nomeFilePdfPreventivo(p);
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Preventivo ${p.clienteNome}` }); }
    catch (e) { if (e && e.name !== "AbortError") console.error(e); }
    return;
  }
  alert("Il telefono non supporta la condivisione diretta del file: scarico il PDF, poi allegalo tu su WhatsApp.");
  doc.save(filename);
}

function inviaPdfEmail(p) {
  if (typeof window.jspdf === "undefined") {
    alert("Libreria PDF non disponibile: assicurati di avere connessione internet e riprova.");
    return;
  }
  const doc = costruisciPdfPreventivo(p);
  const filename = nomeFilePdfPreventivo(p);
  const oggetto = `Preventivo — ${p.clienteNome || ""}`;
  const corpo = `Buongiorno,\n\nin allegato il preventivo${p.clienteNome ? " per " + p.clienteNome : ""}.\n\nRestando a disposizione per qualsiasi chiarimento, saluti.`;
  alert("Scarico il PDF e apro subito la mail: ricordati di allegarlo tu prima di inviare (la mail da sola non può farlo in automatico).");
  doc.save(filename);
  const link = `mailto:?subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(corpo)}`;
  window.location.href = link;
}

function importaCSV(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    if (typeof XLSX === "undefined") {
      const msg = "Libreria Excel non disponibile: assicurati di avere connessione internet e riprova (la prima volta va scaricata).";
      state.backupMsg = msg;
      alert(msg);
      render();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const rows = raw.map((obj) => {
          const row = {};
          Object.keys(obj).forEach((k) => { row[normalizeHeader(k)] = obj[k]; });
          return row;
        });
        if (rows.length === 0) {
          const msg = "Il file sembra vuoto o senza intestazioni riconoscibili.";
          state.backupMsg = msg;
          alert(msg);
          render();
          return;
        }
        importaRighe(rows);
      } catch (e) {
        console.error(e);
        const msg = "Errore nella lettura del file Excel: " + (e && e.message ? e.message : e);
        state.backupMsg = msg;
        alert(msg);
        render();
      }
    };
    reader.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importaRighe(parseCSV(reader.result));
    } catch (e) {
      console.error(e);
      state.backupMsg = "Errore nella lettura del CSV.";
      render();
    }
  };
  reader.readAsText(file, "UTF-8");
}
function euro(n) { const v = Number(n) || 0; return v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function oggi() { return new Date().toISOString().slice(0, 10); }
function garanziaAttiva(job) {
  if (!job.inGaranzia || !job.garanziaScadenza) return false;
  return new Date(job.garanziaScadenza) >= new Date(new Date().toDateString());
}

function resizeImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- derived totals ----------
function calcEntrateLavori() {
  return state.lavori.reduce((s, j) => {
    if (j.statoPagamento === "pagato") return s + (Number(j.importo) || 0);
    if (j.statoPagamento === "acconto") return s + (Number(j.acconto) || 0);
    return s;
  }, 0);
}
function calcEntrateManuali() { return state.movimenti.filter((m) => m.tipo === "entrata").reduce((s, m) => s + (Number(m.importo) || 0), 0); }
function calcUsciteTotali() { return state.movimenti.filter((m) => m.tipo === "uscita").reduce((s, m) => s + (Number(m.importo) || 0), 0); }
function calcValoreMagazzino() { return state.articoli.reduce((s, a) => s + (Number(a.quantita) || 0) * (Number(a.costoUnitario) || 0), 0); }

// ---------- root render ----------
const root = document.getElementById("root");
const TAB_ORDER = ["coda", "impegni", "lavori", "impianti", "preventivi", "magazzino", "cassa"];
let touchStartX = null, touchStartY = null;
document.addEventListener("touchstart", (e) => {
  if (state.showSettings) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (touchStartX == null || state.showSettings) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  touchStartX = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  // ignora lo swipe se stiamo dentro un form/dettaglio (evita conflitti con la modifica dei campi)
  const subView = { lavori: state.viewLavori, magazzino: state.viewMagazzino, impianti: state.viewImpianti, cassa: state.viewCassa, impegni: state.viewImpegni }[state.tab];
  if (subView && subView !== "lista") return;
  const idx = TAB_ORDER.indexOf(state.tab);
  if (idx === -1) return;
  const nextIdx = dx < 0 ? idx + 1 : idx - 1;
  if (nextIdx < 0 || nextIdx >= TAB_ORDER.length) return;
  state.tab = TAB_ORDER[nextIdx];
  render();
}, { passive: true });

function renderLogin() {
  return `
    <div class="app sec-lavori" style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
      <div class="sheet" data-stop style="max-width:340px;width:100%;border-radius:20px;box-shadow:6px 6px 0 rgba(33,29,23,.25);">
        <div class="sheet-head">
          <h3>TO-DO</h3>
        </div>
        <p style="font-size:11px;opacity:.6;margin:-4px 0 16px;">Accedi con l'account condiviso per vedere i dati su questo dispositivo.</p>
        <form id="formLogin">
          <label class="field">
            <input class="input" type="email" name="email" placeholder="Email" required autocomplete="username" />
          </label>
          <label class="field">
            <input class="input" type="password" name="password" placeholder="Password" required autocomplete="current-password" />
          </label>
          ${state.authError ? `<p class="mono" style="font-size:11px;color:#B23A2E;margin:-6px 0 12px;">${esc(state.authError)}</p>` : ""}
          <button class="btn-primary" type="submit" style="width:100%;" ${state.authLoading ? "disabled" : ""}>${state.authLoading ? "Accesso in corso..." : "Accedi"}</button>
        </form>
      </div>
    </div>`;
}

function render() {
  if (state.authLoading) { root.innerHTML = ""; return; }
  if (!state.authUser) { root.innerHTML = renderLogin(); return; }
  const parts = [
    state.showSettings ? renderSettings() : "",
    state.showPreview ? renderPreviewOverlay() : "",
    `<div class="content sec-${{ lavori: "lavori", coda: "dafare", impegni: "impegni", magazzino: "magazzino", impianti: "impianti", cassa: "cassa", preventivi: "preventivi" }[state.tab] || "lavori"}">${renderTabContent()}</div>`,
    renderBottomNav(),
  ];
  root.innerHTML = `<div class="app">${parts.join("")}</div>`;
  updateBadge();
}

function updateBadge() {
  if (!("setAppBadge" in navigator)) return;
  try {
    if (state.coda.length > 0) navigator.setAppBadge(state.coda.length);
    else navigator.clearAppBadge();
  } catch (e) { /* non supportato su questo dispositivo */ }
}

function renderTopbar() {
  return `
    <div class="header-brand">
      <div class="header-brand-top">
        <span class="brand-name">TO-DO</span>
        <button class="gear" data-action="open-settings" aria-label="Impostazioni">
          &#9881;&#65039;${state.syncError ? `<span class="backup-dot" title="${esc(state.syncError)}"></span>` : backupInRitardo() ? `<span class="backup-dot"></span>` : ""}
        </button>
      </div>
      <p class="brand-sub">v.${APP_VERSION} &middot; Claude AI x Aldo</p>
      ${fmtUltimaModifica() ? `<p class="brand-sub" style="opacity:.7;margin-top:-2px;">${fmtUltimaModifica()}</p>` : ""}
    </div>`;
}

function renderSettings() {
  const lastBackup = localStorage.getItem("todo_lastBackup");
  return `
    <div class="overlay" data-action="close-settings">
      <div class="sheet" data-stop data-action="noop">
        <div class="sheet-head">
          <h3>Impostazioni</h3>
          <button class="sheet-close" data-action="close-settings">&#10005;</button>
        </div>
        <label class="field" style="margin-bottom:14px;">
          <label style="margin-bottom:2px;display:block;">Account</label>
          <p style="font-size:12px;font-weight:700;margin:0 0 2px;">${esc((state.authUser && state.authUser.email) || "")}</p>
          <p style="font-size:10px;opacity:.6;margin:0 0 8px;">Dispositivo: ${esc(getDeviceLabel())} &middot; dati sincronizzati in tempo reale su Cellulare, aldo_portatile e aldo_server.</p>
          <input class="input" type="text" id="deviceLabelInput" value="${esc(getDeviceLabel())}" placeholder="Es. aldo_portatile, Cellulare" style="margin-bottom:8px;" />
          <button class="btn-secondary" data-action="logout">Esci da questo account</button>
        </label>
        ${state.syncError ? `<p class="mono" style="font-size:10.5px;color:#B23A2E;font-weight:700;margin:-8px 0 10px;">&#9888; ${esc(state.syncError)}</p>` : ""}

        <label class="field"><label style="margin-bottom:2px;display:block;">Backup generale</label></label>
        <p style="font-size:10px;opacity:.6;margin:0 0 8px;line-height:1.4;">Tutto, catalogo prodotti e foto compresi. Fanne uno prima di disinstallare l'app o come rete di sicurezza periodica.</p>
        ${lastBackup ? `<p class="mono" style="font-size:10px;margin:-4px 0 10px;${backupInRitardo() ? "color:#B23A2E;font-weight:600;" : "opacity:.5;"}">Ultimo backup: ${esc(lastBackup)}${giorniDaUltimoBackup() >= 1 ? ` (${giorniDaUltimoBackup()} ${giorniDaUltimoBackup() === 1 ? "giorno" : "giorni"} fa)` : " (oggi)"}</p>` : `<p class="mono" style="font-size:10px;margin:-4px 0 10px;${backupInRitardo() ? "color:#B23A2E;font-weight:600;" : "opacity:.5;"}">Nessun backup ancora effettuato</p>`}
        <button class="btn-primary" data-action="backup">Backup generale — scarica file</button>
        <input type="file" id="restoreInput" accept="application/json" class="file-input" data-action="noop" />
        <label class="btn-secondary" for="restoreInput" data-action="noop" style="display:block;text-align:center;">${state.restoring ? "Ripristino..." : "Ripristina backup generale"}</label>
        <p style="font-size:10px;opacity:.55;margin:-4px 0 8px;line-height:1.4;">Il ripristino sostituisce tutti i dati e li carica su Firebase, visibili subito su tutti e 3 i dispositivi.</p>
        ${state.backupMsg ? `<p class="settings-msg" style="margin-top:4px;">${esc(state.backupMsg)}</p>` : ""}

        <label class="field"><label style="margin:16px 0 4px;display:block;">Importa da Excel</label></label>
        <p style="font-size:10px;opacity:.6;margin:0 0 8px;line-height:1.4;">Importa direttamente .xlsx o CSV. Colonne: numero, cliente, descrizione, data, telefono, importo, stato, acconto, garanzia, scadenza garanzia, remoto, note.</p>
        <input type="file" id="importCsvInput" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" class="file-input" data-action="noop" />
        <label class="btn-secondary" for="importCsvInput" data-action="noop" style="display:block;text-align:center;">Importa lavori da Excel/CSV</label>
        <button class="btn-secondary" style="margin-top:8px;" data-action="rinumera-lavori">Rinumera lavori per anno (001, 002... per ogni anno)</button>
        <input type="file" id="importImpiantiInput" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" class="file-input" data-action="noop" />
        <label class="btn-secondary" for="importImpiantiInput" data-action="noop" style="display:block;text-align:center;">Importa impianti da Excel/CSV</label>
        <label class="field"><label style="margin:14px 0 4px;display:block;">Memoria</label></label>
        <p style="font-size:10px;opacity:.6;margin:0 0 8px;line-height:1.4;">Il telefono può, in rari casi, liberare spazio cancellando i dati dell'app. Chiedere memoria "persistente" riduce il rischio (fai comunque backup regolari).</p>
        <div id="storageStatus" class="mono" style="font-size:11px;margin-bottom:8px;">Verifica in corso...</div>
        <button class="btn-secondary" data-action="check-persist">Richiedi/verifica memoria persistente</button>
      </div>
    </div>`;
}

function renderBottomNav() {
  const tabs = [["coda", "&#128203;", "Da fare"], ["impegni", "&#128197;", "Impegni"], ["lavori", "&#128295;", "Lavori"], ["impianti", "&#128680;", "Impianti"], ["preventivi", "&#128221;", "Prevent."], ["magazzino", "&#128230;", "Magazzino"], ["cassa", "&#128176;", "Cassa"]];
  return `<nav class="bottom-nav">${tabs.map(([key, ico, label]) => `
    <button class="nav-btn ${state.tab === key ? "active" : ""}" data-action="set-tab" data-tab="${key}">
      <span class="ico">${ico}</span>${label}
    </button>`).join("")}</nav>`;
}

function inviaReportCodaWhatsapp() {
  if (!state.coda.length) return;
  const oggiIt = fmtData(oggi());
  let testo = `*Lavori da fare* (${oggiIt})\n\n`;
  state.coda.forEach((c, i) => { testo += `${i + 1}. ${c.cliente}\n`; });
  const url = `https://wa.me/?text=${encodeURIComponent(testo)}`;
  window.open(url, "_blank");
}

function inviaImpegnoWhatsapp(impegno) {
  let testo = `*Impegno*${impegno.numeroImpegno ? " N° " + impegno.numeroImpegno : ""}\n`;
  testo += `📅 ${fmtData(impegno.data)}${impegno.ora ? " alle " + impegno.ora : ""}\n`;
  testo += `👤 ${impegno.cliente}\n`;
  if (impegno.luogo) testo += `📍 ${impegno.luogo}\n`;
  if (impegno.note) testo += `📝 ${impegno.note}\n`;
  const url = `https://wa.me/?text=${encodeURIComponent(testo)}`;
  window.open(url, "_blank");
}

function renderTabContent() {
  if (state.tab === "lavori") return renderLavori();
  if (state.tab === "coda") return renderCoda();
  if (state.tab === "impegni") return renderImpegni();
  if (state.tab === "magazzino") return renderMagazzino();
  if (state.tab === "impianti") return renderImpianti();
  if (state.tab === "cassa") return renderCassa();
  if (state.tab === "preventivi") return renderPreventiviTab();
  return "";
}

// ============ DA FARE (coda) ============
function renderCoda() {
  const rows = state.coda.map((c, idx) => `
    <div class="movement-row">
      <div class="reorder">
        <button class="reorder-btn" data-action="coda-up" data-id="${c.id}" ${idx === 0 ? "disabled" : ""}>&#9650;</button>
        <button class="reorder-btn" data-action="coda-down" data-id="${c.id}" ${idx === state.coda.length - 1 ? "disabled" : ""}>&#9660;</button>
      </div>
      <div class="grow"><p class="desc">${esc(c.cliente)}</p></div>
      <button class="del" data-action="delete-coda" data-id="${c.id}">&#10005;</button>
    </div>`).join("");
  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">In coda</p><h1>Lavori da fare</h1></div>
        <div class="header-stat"><div class="num">${String(state.coda.length).padStart(3, "0")}</div><div class="label">in attesa</div></div>
      </div>
    </div>
    <div class="add-row"><input class="input" id="codaInput" placeholder="Nome cliente" /><button type="button" data-action="add-coda">+</button></div>
    ${state.coda.length === 0 ? `<div class="empty"><span class="ico">&#128203;</span><p>Nessun lavoro in coda al momento.</p></div>` : `<div>${rows}</div>`}
    ${state.coda.length > 0 ? `<button class="btn-secondary btn-whatsapp" data-action="report-coda-whatsapp"><svg viewBox="0 0 24 24" width="18" height="18" fill="#25D366" style="vertical-align:-4px;margin-right:6px;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39c1.45.79 3.08 1.21 4.75 1.21h.004c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0012.04 2m0 1.67a8.2 8.2 0 018.24 8.24c0 4.55-3.7 8.25-8.25 8.25a8.2 8.2 0 01-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 01-1.26-4.38c0-4.55 3.7-8.25 8.25-8.25M8.53 6.7c-.16 0-.43.06-.66.31-.22.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.13.17 1.75 2.8 4.32 3.82 2.14.85 2.57.68 3.04.64.46-.04 1.5-.61 1.71-1.2.21-.59.21-1.09.15-1.2-.06-.11-.23-.17-.48-.3-.25-.13-1.5-.74-1.73-.82-.23-.09-.4-.13-.57.13-.17.25-.65.82-.8.99-.15.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.44.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.42-.79-1.94-.2-.48-.41-.42-.57-.43z"/></svg>Invia report su WhatsApp</button>` : ""}`;
}

// ============ LAVORI ============
function renderLavori() {
  if (state.viewLavori === "form") return renderLavoroForm();
  if (state.viewLavori === "dettaglio") return renderLavoroDettaglio();
  return renderLavoriLista();
}

function headerLavori() {
  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Registro</p><h1>I miei lavoretti</h1></div>
        <div class="header-stat" data-action="filter-lavori" data-filter="tutti" style="cursor:pointer;"><div class="num">${String(state.lavori.length).padStart(3, "0")}</div><div class="label">totali</div></div>
      </div>
    </div>`;
}

function parseNumeroIntervento(s) {
  const m = /^(\d+)-(\d{4})$/.exec((s || "").trim());
  if (!m) return { num: -1, anno: 0 };
  return { num: Number(m[1]), anno: Number(m[2]) };
}
function ordinaPerNumeroDesc(a, b, numA, numB) {
  const pa = parseNumeroIntervento(numA), pb = parseNumeroIntervento(numB);
  if (pb.anno !== pa.anno) return pb.anno - pa.anno;
  if (pb.num !== pa.num) return pb.num - pa.num;
  return (b.data || "").localeCompare(a.data || "");
}

function matchFiltroLavoro(j, filtro) {
  if (filtro === "da_pagare") return !j.remoto && !j.inGaranzia && j.statoPagamento !== "pagato" && j.statoPagamento !== "acconto";
  if (filtro === "garanzia") return !!j.inGaranzia;
  if (filtro === "pagato") return j.statoPagamento === "pagato";
  if (filtro === "acconto") return j.statoPagamento === "acconto";
  if (filtro === "remoto") return !!j.remoto;
  if (filtro && filtro.startsWith("anno:")) return (j.data || "").startsWith(filtro.slice(5));
  return true;
}

function renderLavoriLista() {
  const q = state.queryLavori.toLowerCase();
  const ordinati = [...state.lavori].sort((a, b) => ordinaPerNumeroDesc(a, b, a.numeroIntervento, b.numeroIntervento));
  const filtered = ordinati.filter((j) => {
    if (!matchFiltroLavoro(j, state.filterLavori)) return false;
    if (q && !j.cliente.toLowerCase().includes(q) && !j.descrizione.toLowerCase().includes(q)) return false;
    return true;
  });
  const cards = filtered.map((job) => {
    const g = garanziaAttiva(job);
    const payClass = job.statoPagamento === "pagato" ? "green" : job.statoPagamento === "acconto" ? "amber" : "red";
    const payLabel = job.statoPagamento === "pagato" ? "Pagato" : job.statoPagamento === "acconto" ? "Acconto" : "Da pagare";
    const amountDisplay = job.remoto || job.inGaranzia ? "" :
      job.statoPagamento === "acconto" ? `&euro;${euro(job.acconto)} <span style="opacity:.5;">di &euro;${euro(job.importo)}</span>` :
      job.importo ? `&euro;${esc(job.importo)}` : "";
    return `
    <div class="tag-card" data-action="open-lavoro-detail" data-id="${job.id}" role="button" tabindex="0">
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
        <p class="tag-title" style="margin:0;">${esc(job.cliente)}</p>
        ${!job.remoto && !job.inGaranzia ? `<span class="badge ${payClass}">${payLabel}</span>` : ""}
        ${job.inGaranzia ? `<span class="badge amber">&#128737;&#65039; garanzia${job.garanziaScadenza ? " fino al " + fmtData(job.garanziaScadenza) : ""}</span>` : ""}
        ${job.remoto ? `<span class="badge blue">&#128225; da remoto</span>` : ""}
      </div>
      <p class="tag-sub" style="margin-top:2px;">${esc(job.descrizione)}</p>
      <div class="tag-top" style="margin-top:6px;align-items:center;">
        <p class="tag-date" style="margin:0;">${fmtData(job.data)}${job.numeroIntervento ? ` &middot; N&deg; ${esc(job.numeroIntervento)}` : ""}</p>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${amountDisplay ? `<span class="card-amount">${amountDisplay}</span>` : ""}
          ${job.foto && job.foto[0] ? `<img class="tag-thumb" src="${job.foto[0]}" alt="" />` : ""}
          <button class="edit-pencil" data-action="edit-lavoro" data-id="${job.id}" aria-label="Modifica">&#9999;&#65039;</button>
        </div>
      </div>
    </div>`;
  }).join("");

  return headerLavori() + `
    <div class="searchbar"><span>&#128269;</span><input id="searchLavori" placeholder="Cerca cliente o lavoro..." value="${esc(state.queryLavori)}" /></div>
    <div class="filters">
      <select class="input mono" id="filterSelectLavori" style="font-size:12.5px;padding:9px 12px;">
        <option value="tutti" ${state.filterLavori === "tutti" ? "selected" : ""}>Tutti (${state.lavori.length})</option>
        <option value="da_pagare" ${state.filterLavori === "da_pagare" ? "selected" : ""}>Da pagare (${state.lavori.filter((j) => matchFiltroLavoro(j, "da_pagare")).length})</option>
        <option value="acconto" ${state.filterLavori === "acconto" ? "selected" : ""}>Acconto (${state.lavori.filter((j) => matchFiltroLavoro(j, "acconto")).length})</option>
        <option value="garanzia" ${state.filterLavori === "garanzia" ? "selected" : ""}>In garanzia (${state.lavori.filter((j) => matchFiltroLavoro(j, "garanzia")).length})</option>
        <option value="pagato" ${state.filterLavori === "pagato" ? "selected" : ""}>Pagato (${state.lavori.filter((j) => matchFiltroLavoro(j, "pagato")).length})</option>
        <option value="remoto" ${state.filterLavori === "remoto" ? "selected" : ""}>Da remoto (${state.lavori.filter((j) => matchFiltroLavoro(j, "remoto")).length})</option>
        ${[...new Set(state.lavori.map((j) => (j.data || "").slice(0, 4)).filter(Boolean))].sort().reverse().map((y) => `<option value="anno:${y}" ${state.filterLavori === "anno:" + y ? "selected" : ""}>Anno ${y} (${state.lavori.filter((j) => matchFiltroLavoro(j, "anno:" + y)).length})</option>`).join("")}
      </select>
    </div>
    ${filtered.length === 0 ? `<div class="empty"><span class="ico">&#128295;</span><p>Nessun lavoretto qui. Aggiungine uno con il tasto +.</p></div>` : cards}
    <button class="fab" data-action="new-lavoro">+</button>`;
}

function prossimoNumeroIntervento(annoForzato) {
  const anno = annoForzato || new Date().getFullYear();
  let max = 0;
  state.lavori.forEach((j) => {
    const m = /^(\d{3})-(\d{4})$/.exec(j.numeroIntervento || "");
    if (m && Number(m[2]) === anno) max = Math.max(max, Number(m[1]));
  });
  return `${String(max + 1).padStart(3, "0")}-${anno}`;
}

function renderLavoroForm() {
  const f = state.formLavoro || {};
  const materiali = f.materiali || [];
  const foto = f.foto || [];
  const stato = f.statoPagamento || "da_pagare";
  const numeroIntervento = f.numeroIntervento || prossimoNumeroIntervento();
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-lavori">&#8249;</button>
      <h2>${f.id ? "Modifica lavoretto" : "Nuovo lavoretto"}</h2>
    </div>
    <form id="formLavoro">
      <div class="field"><label>Data</label><input type="date" class="input" name="data" value="${f.data || oggi()}" /></div>
      <div class="field"><label>N&deg; intervento</label><input class="input mono" name="numeroIntervento" value="${esc(numeroIntervento)}" placeholder="000-${new Date().getFullYear()}" /></div>
      <div class="field"><label>Cliente * (Cognome e Nome)</label><input class="input" name="cliente" id="clienteLavoroInput" list="clientiImpiantiList" value="${esc(f.cliente)}" placeholder="Cognome Nome" required />
        <datalist id="clientiImpiantiList">${[...new Set(state.impianti.map((i) => i.nome))].map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <p id="clienteImpiantoMatch" style="font-size:11px;margin:4px 0 0;${state.impianti.some((i) => i.nome.toLowerCase() === (f.cliente || "").toLowerCase()) ? "color:#1F5C33;font-weight:700;" : "opacity:.5;"}">${state.impianti.some((i) => i.nome.toLowerCase() === (f.cliente || "").toLowerCase()) ? "&#9989; Collegato all'impianto registrato con questo nome." : "Se il nome corrisponde a un impianto già registrato, l'intervento viene collegato a quella scheda."}</p>
      </div>
      <div class="field"><label>Telefono</label><input class="input" name="telefono" value="${esc(f.telefono)}" placeholder="Facoltativo" /></div>
      <div class="field"><label>Descrizione lavoro *</label><textarea class="input" name="descrizione" placeholder="Es. sostituzione centralina allarme..." required>${esc(f.descrizione)}</textarea></div>
      <div class="field"><label><input type="checkbox" id="remotoCheck" ${f.remoto ? "checked" : ""} /> Intervento da remoto (nessun pagamento)</label></div>
      <div class="field">
        <label><input type="checkbox" id="inGaranziaCheck" ${f.inGaranzia ? "checked" : ""} /> Intervento in garanzia (nessun pagamento)</label>
        <input type="date" class="input" name="garanziaScadenza" id="garanziaScadenzaInput" value="${f.garanziaScadenza || ""}" style="${f.inGaranzia ? "" : "display:none;"} margin-top:8px;" placeholder="Scadenza garanzia" />
      </div>

      <div class="field" id="pagamentoSection" style="${(f.remoto || f.inGaranzia) ? "display:none;" : ""}">
        <label>Pagamento</label>
        <div class="seg" id="segPagamento">
          ${["da_pagare", "acconto", "pagato"].map((k) => `<button type="button" class="seg-btn ${stato === k ? "active" : ""}" data-stato="${k}">${k === "da_pagare" ? "Da pagare" : k === "acconto" ? "Acconto" : "Pagato"}</button>`).join("")}
        </div>
        <input type="hidden" name="statoPagamento" id="statoPagamentoInput" value="${stato}" />
        <div class="euro-input"><span>&euro;</span><input type="number" step="0.01" name="importo" placeholder="Importo totale lavoro" value="${esc(f.importo)}" /></div>
        <div class="euro-input" id="accontoRow" style="${stato === "acconto" ? "" : "display:none;"}"><span>&euro;</span><input type="number" step="0.01" name="acconto" placeholder="Acconto già ricevuto" value="${esc(f.acconto)}" /></div>
      </div>

      <div class="field" id="materialiSection" style="${f.remoto ? "display:none;" : ""}">
        <label>Materiali / pezzi usati</label>
        <div class="add-row">
          <input class="input" id="materialeInput" list="materialiList" placeholder="Es. sensore volumetrico" style="flex:2;" />
          <input class="input" id="materialeQtaInput" type="number" min="1" step="1" value="1" style="flex:0 0 60px;" />
          <button type="button" data-action="add-materiale">+</button>
        </div>
        <datalist id="materialiList">${[...new Set(state.articoli.map((a) => a.nome))].map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <p style="font-size:11px;opacity:.5;margin:2px 0 8px;">Se il nome corrisponde a un articolo a magazzino, la quantità viene scalata in automatico.</p>
        <div class="chip-row" id="materialiChips">${materiali.map((m, i) => `<span class="chip">${esc(typeof m === "string" ? m : m.nome)}${typeof m === "object" && m.quantita > 1 ? " ×" + m.quantita : ""}${typeof m === "object" && m.articoloId ? " &#128230;" : ""}<span class="rm" data-action="rm-materiale" data-idx="${i}">&#10005;</span></span>`).join("")}</div>
      </div>

      <div class="field">
        <label>Foto (facoltative)</label>
        <input type="file" id="fotoInput" accept="image/*" class="file-input" data-action="noop" />
        <div class="photo-row" id="fotoRow">
          ${foto.map((src, i) => `<div class="photo-thumb"><img src="${src}" /><button type="button" class="rm" data-action="rm-foto" data-idx="${i}">&#10005;</button></div>`).join("")}
          <label class="photo-add" for="fotoInput" data-action="noop">&#128247;</label>
        </div>
      </div>

      <div class="field"><label>Note</label><textarea class="input" name="note" placeholder="Altre note...">${esc(f.note)}</textarea></div>

      <div class="btn-row">
        ${f.id ? `<button type="button" class="btn-danger" data-action="delete-lavoro" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">Salva lavoretto</button>
      </div>
    </form>`;
}

function renderLavoroDettaglio() {
  const j = state.detailLavoro;
  if (!j) return "";
  const payClass = j.statoPagamento === "pagato" ? "green" : j.statoPagamento === "acconto" ? "amber" : "red";
  const payLabel = j.statoPagamento === "pagato" ? "Pagato" : j.statoPagamento === "acconto" ? `Acconto &euro;${euro(j.acconto)} di &euro;${euro(j.importo)}` : "Da pagare";
  const g = garanziaAttiva(j);
  return `
    <div class="form-header" style="justify-content:space-between;">
      <button class="back-btn" data-action="back-lavori">&#8249;</button>
      <button class="edit-link" data-action="edit-lavoro" data-id="${j.id}">&#9999;&#65039; Modifica</button>
    </div>
    <div class="detail-card">
      <p class="tag-date">${fmtData(j.data)}${j.numeroIntervento ? ` &middot; N&deg; ${esc(j.numeroIntervento)}` : ""}</p>
      <h2>${esc(j.cliente)}</h2>
      ${j.telefono ? `<p class="mono" style="opacity:.6;font-size:13px;">${esc(j.telefono)}</p>` : ""}
      <p style="margin-top:12px;font-size:14px;line-height:1.5;">${esc(j.descrizione)}</p>
      <div class="tag-badges" style="margin-top:16px;">
        ${!j.remoto && !j.inGaranzia ? `<span class="badge ${payClass}">${payLabel}${j.statoPagamento !== "acconto" && j.importo ? " &middot; &euro;" + esc(j.importo) : ""}</span>` : ""}
        ${j.inGaranzia ? `<span class="badge amber">&#128737;&#65039; garanzia${j.garanziaScadenza ? " fino al " + fmtData(j.garanziaScadenza) : ""}</span>` : ""}
        ${j.remoto ? `<span class="badge blue">&#128225; da remoto</span>` : ""}
      </div>
      ${j.materiali && j.materiali.length ? `<div class="detail-section"><p class="lbl">Materiali usati</p><div class="chip-row">${j.materiali.map((m) => `<span class="chip">${esc(typeof m === "string" ? m : m.nome)}${typeof m === "object" && m.quantita > 1 ? " ×" + m.quantita : ""}</span>`).join("")}</div></div>` : ""}
      ${j.foto && j.foto.length ? `<div class="detail-section"><p class="lbl">Foto</p><div class="photo-row">${j.foto.map((f) => `<img src="${f}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--border);" />`).join("")}</div></div>` : ""}
      ${j.note ? `<div class="detail-section"><p class="lbl">Note</p><p style="font-size:14px;opacity:.8;">${esc(j.note)}</p></div>` : ""}
    </div>`;
}

// ============ MAGAZZINO ============
function renderMagazzino() {
  return state.viewMagazzino === "form" ? renderArticoloForm() : renderMagazzinoLista();
}

function renderMagazzinoLista() {
  const q = state.queryMagazzino.toLowerCase();
  const filtered = state.articoli.filter((a) => !q || a.nome.toLowerCase().includes(q));
  const valore = calcValoreMagazzino();
  const cards = filtered.map((a) => `
    <div class="tag-card" data-action="edit-articolo" data-id="${a.id}" role="button" tabindex="0">
      <div class="tag-top">
        <div>
          ${a.dataUltimoCarico ? `<p class="tag-date">${esc(a.dataUltimoCarico)}</p>` : ""}
          <p class="tag-title">${esc(a.nome)}</p>
          ${a.fornitore ? `<p class="tag-sub">${esc(a.fornitore)}</p>` : ""}
        </div>
        <div style="display:flex;align-items:flex-start;gap:8px;flex-shrink:0;">
          <div style="text-align:right;"><p class="mono" style="font-weight:600;font-size:14px;margin:0;">${esc(a.quantita)} pz</p><p class="mono" style="font-size:12px;opacity:.8;margin:2px 0 0;">&euro;${euro(a.costoUnitario)}/pz</p></div>
          <button class="edit-pencil" data-action="edit-articolo" data-id="${a.id}" aria-label="Modifica">&#9999;&#65039;</button>
        </div>
      </div>
    </div>`).join("");

  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Scorte materiali</p><h1>Magazzino</h1></div>
        <div class="header-stat"><div class="num">&euro;${euro(valore)}</div><div class="label">valore stock</div></div>
      </div>
      <p class="mono" style="font-size:10px;margin-top:12px;background:var(--ink);color:#fff;display:inline-block;padding:3px 9px;border-radius:6px;font-weight:800;">${state.articoli.length} articoli a magazzino</p>
    </div>
    <div class="searchbar"><span>&#128269;</span><input id="searchMagazzino" placeholder="Cerca articolo..." value="${esc(state.queryMagazzino)}" /></div>
    ${filtered.length === 0 ? `<div class="empty"><span class="ico">&#128230;</span><p>Magazzino vuoto. Registra un carico con il tasto +.</p></div>` : cards}
    <button class="fab" data-action="new-articolo">+</button>`;
}

function renderArticoloForm() {
  const f = state.formArticolo || {};
  const corr = state.isCorrezione;
  const nomiEsistenti = [...new Set(state.articoli.map((a) => a.nome).filter(Boolean))];
  const fornitoriEsistenti = [...new Set(state.articoli.map((a) => a.fornitore).filter(Boolean))];
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-magazzino">&#8249;</button>
      <h2>${corr ? "Modifica articolo" : "Nuovo carico"}</h2>
    </div>
    ${!corr ? `<p style="font-size:12px;opacity:.6;margin-bottom:16px;">Registra un acquisto: se l'articolo esiste già, la quantità si somma a quella in magazzino. La spesa viene aggiunta automaticamente in Cassa.</p>` : ""}
    <form id="formArticolo">
      <div class="field"><label>Data ${corr ? "ultimo carico" : "acquisto"}</label><input class="input date-it" name="dataUltimoCarico" value="${esc(f.dataUltimoCarico) || fmtData(oggi())}" placeholder="gg/mm/aaaa" inputmode="numeric" maxlength="10" /></div>
      <div class="field"><label>Articolo *</label><input class="input" name="nome" list="nomiList" value="${esc(f.nome)}" placeholder="Es. sensore volumetrico" ${corr ? "disabled" : ""} required />
        <datalist id="nomiList">${nomiEsistenti.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      </div>
      <div class="field"><label>${corr ? "Quantità in magazzino" : "Quantità acquistata *"}</label><input type="number" step="0.01" class="input" name="quantita" value="${esc(f.quantita)}" placeholder="0" required /></div>
      <div class="field"><label>Costo unitario (&euro;)</label><input type="number" step="0.01" class="input" name="costoUnitario" value="${esc(f.costoUnitario)}" placeholder="0.00" /></div>
      <div class="field"><label>Fornitore</label><input class="input" name="fornitore" list="fornitoriList" value="${esc(f.fornitore)}" placeholder="Grossista o portale online" />
        <datalist id="fornitoriList">${fornitoriEsistenti.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      </div>
      ${corr && f.storicoCarichi && f.storicoCarichi.length ? `
      <div class="field">
        <label>Storico acquisti</label>
        <div class="chip-row" style="flex-direction:column;align-items:stretch;gap:6px;">
          ${f.storicoCarichi.slice().reverse().map((c) => `
            <div class="movement-row" style="margin-bottom:0;">
              <div class="grow">
                <p class="desc">${esc(c.quantita)} pz &middot; &euro;${euro(c.costoUnitario)}/pz${c.fornitore ? " &middot; " + esc(c.fornitore) : ""}</p>
                <p class="meta">${esc(c.data)}</p>
              </div>
            </div>`).join("")}
        </div>
      </div>` : ""}
      <div class="btn-row">
        ${corr ? `<button type="button" class="btn-danger" data-action="delete-articolo" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">${corr ? "Salva modifiche" : "Registra carico"}</button>
      </div>
    </form>`;
}

// ============ IMPEGNI ============
function renderImpegni() {
  return state.viewImpegni === "form" ? renderImpegnoForm() : renderImpegniLista();
}

function renderImpegniLista() {
  const q = state.queryImpegni.toLowerCase();
  const ordinati = [...state.impegni].sort((a, b) => (Number(b.numeroImpegno) || 0) - (Number(a.numeroImpegno) || 0));
  const filtered = ordinati.filter((i) => !q || i.cliente.toLowerCase().includes(q) || (i.luogo || "").toLowerCase().includes(q));
  const cards = filtered.map((i) => `
    <div class="tag-card" data-action="edit-impegno" data-id="${i.id}" role="button" tabindex="0">
      <div class="tag-top">
        <div>
          <p class="tag-date">${fmtData(i.data)}${i.ora ? ` &middot; ${esc(i.ora)}` : ""}</p>
          <p class="tag-title">${esc(i.cliente)}</p>
          ${i.luogo ? `<p class="tag-sub">${esc(i.luogo)}</p>` : ""}
        </div>
        <div style="display:flex;align-items:flex-start;gap:8px;flex-shrink:0;">
          ${i.numeroImpegno ? `<span class="badge neutral mono" style="font-size:12px;">N&deg; ${esc(i.numeroImpegno)}</span>` : ""}
          <button class="edit-pencil" data-action="edit-impegno" data-id="${i.id}" aria-label="Modifica">&#9999;&#65039;</button>
        </div>
      </div>
      ${i.note ? `<p class="tag-sub" style="margin-top:6px;">${esc(i.note)}</p>` : ""}
      <div style="margin-top:10px;">
        <button class="wa-icon-btn" data-action="whatsapp-impegno" data-id="${i.id}" aria-label="Invia su WhatsApp">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#25D366"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39c1.45.79 3.08 1.21 4.75 1.21h.004c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0012.04 2m0 1.67a8.2 8.2 0 018.24 8.24c0 4.55-3.7 8.25-8.25 8.25a8.2 8.2 0 01-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 01-1.26-4.38c0-4.55 3.7-8.25 8.25-8.25M8.53 6.7c-.16 0-.43.06-.66.31-.22.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.13.17 1.75 2.8 4.32 3.82 2.14.85 2.57.68 3.04.64.46-.04 1.5-.61 1.71-1.2.21-.59.21-1.09.15-1.2-.06-.11-.23-.17-.48-.3-.25-.13-1.5-.74-1.73-.82-.23-.09-.4-.13-.57.13-.17.25-.65.82-.8.99-.15.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.44.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.42-.79-1.94-.2-.48-.41-.42-.57-.43z"/></svg>
          Invia su WhatsApp
        </button>
      </div>
    </div>`).join("");

  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Agenda</p><h1>Impegni</h1></div>
        <div class="header-stat"><div class="num">${String(state.impegni.length).padStart(3, "0")}</div><div class="label">in agenda</div></div>
      </div>
    </div>
    <div class="searchbar"><span>&#128269;</span><input id="searchImpegni" placeholder="Cerca per cliente o luogo..." value="${esc(state.queryImpegni)}" /></div>
    ${filtered.length === 0 ? `<div class="empty"><span class="ico">&#128197;</span><p>Nessun impegno in agenda. Aggiungine uno con il tasto +.</p></div>` : cards}
    <button class="fab" data-action="new-impegno">+</button>`;
}

function renderImpegnoForm() {
  const f = state.formImpegno || {};
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-impegni">&#8249;</button>
      <h2>${f.id ? "Modifica impegno" : "Nuovo impegno"}</h2>
    </div>
    <form id="formImpegno">
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label>Data</label><input type="date" class="input" name="data" value="${f.data || oggi()}" /></div>
        <div class="field" style="flex:1;"><label>Ora</label><input type="time" class="input" name="ora" value="${esc(f.ora)}" /></div>
      </div>
      <div class="field"><label>Numero progressivo</label><input class="input" name="numeroImpegno" value="${esc(f.numeroImpegno)}" placeholder="Es. 12" inputmode="numeric" /></div>
      <div class="field"><label>Cliente *</label><input class="input" name="cliente" value="${esc(f.cliente)}" placeholder="Nome cliente" required /></div>
      <div class="field"><label>Luogo</label><input class="input" name="luogo" value="${esc(f.luogo)}" placeholder="Facoltativo" /></div>
      <div class="field"><label>Note</label><textarea class="input" name="note" placeholder="Altre note...">${esc(f.note)}</textarea></div>
      <div class="btn-row">
        ${f.id ? `<button type="button" class="btn-danger" data-action="delete-impegno" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">Salva impegno</button>
      </div>
    </form>`;
}

// ============ IMPIANTI ============
function renderImpianti() {
  return state.viewImpianti === "form" ? renderImpiantoForm() : renderImpiantiLista();
}

function riepilogoInterventiImpianto(impiantoId) {
  const lavoriCollegati = state.lavori.filter((j) => j.impiantoId === impiantoId);
  const r = {
    garanzia: [], remoto: [], pagato: [], daPagare: [],
  };
  lavoriCollegati.forEach((j) => {
    if (j.inGaranzia) r.garanzia.push(j.data);
    else if (j.remoto) r.remoto.push(j.data);
    else if (j.statoPagamento === "pagato") r.pagato.push(j.data);
    else r.daPagare.push(j.data);
  });
  Object.keys(r).forEach((k) => r[k].sort().reverse());
  return r;
}

function renderImpiantiLista() {
  const q = state.queryImpianti.toLowerCase();
  const tipiCentrale = [...new Set(state.impianti.map((i) => i.tipoCentrale).filter(Boolean))].sort();
  const anniImpianti = [...new Set(state.impianti.map((i) => (/^\d{2}\/\d{2}\/(\d{4})$/.exec(i.dataImpianto || "") || [])[1]).filter(Boolean))].sort().reverse();
  const senzaTipoCount = state.impianti.filter((i) => !i.tipoCentrale).length;
  const ordinati = [...state.impianti].sort((a, b) => (Number(b.numeroImpianto) || 0) - (Number(a.numeroImpianto) || 0));
  const filtered = ordinati.filter((i) => {
    if (state.filterImpianti === "senza_tipo" && i.tipoCentrale) return false;
    else if (state.filterImpianti.startsWith("anno:") && !(i.dataImpianto || "").endsWith(state.filterImpianti.slice(5))) return false;
    else if (state.filterImpianti !== "tutti" && state.filterImpianti !== "senza_tipo" && !state.filterImpianti.startsWith("anno:") && i.tipoCentrale !== state.filterImpianti) return false;
    if (q && !i.nome.toLowerCase().includes(q) && !(i.tipoCentrale || "").toLowerCase().includes(q)) return false;
    return true;
  });
  const cards = filtered.map((i) => `
    <div class="tag-card" data-action="edit-impianto" data-id="${i.id}" role="button" tabindex="0">
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
        <p class="tag-title" style="margin:0;">${esc(i.nome)}</p>
        ${i.tipoCentrale ? `<span class="badge green">&#128680; ${esc(i.tipoCentrale)}</span>` : ""}
      </div>
      ${(() => {
        const r = riepilogoInterventiImpianto(i.id);
        const badges = `
          ${r.garanzia.length ? `<span class="badge amber badge-count">&#127873; ${r.garanzia.length}</span>` : ""}
          ${r.remoto.length ? `<span class="badge blue badge-count">&#128225; ${r.remoto.length}</span>` : ""}
          ${r.pagato.length ? `<span class="badge green badge-count">&#128176; ${r.pagato.length}</span>` : ""}
          ${r.daPagare.length ? `<span class="badge red badge-count">&#128184; ${r.daPagare.length}</span>` : ""}`;
        return badges.trim() ? `<div class="tag-badges" style="margin-top:6px;">${badges}</div>` : "";
      })()}
      <div class="tag-top" style="margin-top:6px;align-items:center;">
        <p class="tag-date" style="margin:0;">${esc(i.dataImpianto)}</p>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${i.numeroImpianto ? `<span class="badge neutral mono" style="font-size:12px;">N&deg; ${esc(i.numeroImpianto)}</span>` : ""}
          <button class="edit-pencil" data-action="edit-impianto" data-id="${i.id}" aria-label="Modifica">&#9999;&#65039;</button>
        </div>
      </div>
      ${i.note ? `<p class="tag-sub" style="margin-top:6px;">${esc(i.note)}</p>` : ""}
    </div>`).join("");

  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Anagrafica</p><h1>Impianti</h1></div>
        <div class="header-stat" data-action="filter-impianti" data-filter="tutti" style="cursor:pointer;"><div class="num">${String(state.impianti.length).padStart(3, "0")}</div><div class="label">installati</div></div>
      </div>
    </div>
    <div class="searchbar"><span>&#128269;</span><input id="searchImpianti" placeholder="Cerca per nome o centrale..." value="${esc(state.queryImpianti)}" /></div>
    <div class="filters">
      <select class="input mono" id="filterSelectImpianti" style="font-size:12.5px;padding:9px 12px;">
        <option value="tutti" ${state.filterImpianti === "tutti" ? "selected" : ""}>Tutti (${state.impianti.length})</option>
        ${tipiCentrale.map((t) => `<option value="${esc(t)}" ${state.filterImpianti === t ? "selected" : ""}>${esc(t)} (${state.impianti.filter((i) => i.tipoCentrale === t).length})</option>`).join("")}
        ${senzaTipoCount > 0 ? `<option value="senza_tipo" ${state.filterImpianti === "senza_tipo" ? "selected" : ""}>Senza tipo centrale (${senzaTipoCount})</option>` : ""}
        ${anniImpianti.map((y) => `<option value="anno:${y}" ${state.filterImpianti === "anno:" + y ? "selected" : ""}>Anno ${y} (${state.impianti.filter((i) => (i.dataImpianto || "").endsWith(y)).length})</option>`).join("")}
      </select>
    </div>
    ${filtered.length === 0 ? `<div class="empty"><span class="ico">&#128680;</span><p>Nessun impianto registrato. Aggiungine uno con il tasto +.</p></div>` : cards}
    <button class="fab" data-action="new-impianto">+</button>`;
}

function renderTabellaInterventiImpianto(impiantoId) {
  const r = riepilogoInterventiImpianto(impiantoId);
  const colonne = [
    { label: "&#127873; Garanzia", dati: r.garanzia },
    { label: "&#128225; Da remoto", dati: r.remoto },
    { label: "&#128176; Pagato", dati: r.pagato },
    { label: "&#128184; Da pagare", dati: r.daPagare },
  ];
  const righeMax = Math.max(0, ...colonne.map((c) => c.dati.length));
  if (righeMax === 0) return `<div class="field"><label>Interventi collegati</label><p style="font-size:12px;opacity:.5;">Nessun intervento ancora collegato a questo impianto.</p></div>`;
  return `
    <div class="field">
      <label>Interventi collegati</label>
      <div style="overflow-x:auto;border:2.5px solid var(--ink);border-radius:10px;">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
          <thead><tr style="background:var(--paper);">${colonne.map((c) => `<th style="text-align:center;padding:7px 6px;white-space:nowrap;">${c.label}</th>`).join("")}</tr></thead>
          <tbody>
            ${Array.from({ length: righeMax }).map((_, i) => `
              <tr style="border-top:1px solid var(--border);">${colonne.map((c) => `<td style="text-align:center;padding:6px;font-family:var(--mono);">${c.dati[i] ? fmtData(c.dati[i]) : ""}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderImpiantoForm() {
  const f = state.formImpianto || {};
  const tipiEsistenti = [...new Set(state.impianti.map((i) => i.tipoCentrale).filter(Boolean))];
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-impianti">&#8249;</button>
      <h2>${f.id ? "Modifica impianto" : "Nuovo impianto"}</h2>
    </div>
    <form id="formImpianto">
      <div class="field"><label>Data impianto</label><input class="input date-it" name="dataImpianto" id="dataImpiantoInput" value="${esc(f.dataImpianto) || fmtData(oggi())}" placeholder="gg/mm/aaaa" inputmode="numeric" maxlength="10" /></div>
      <div class="field"><label>Numero impianto</label><input class="input" name="numeroImpianto" value="${esc(f.numeroImpianto)}" placeholder="Es. 42" inputmode="numeric" /></div>
      <div class="field"><label>Nome *</label><input class="input" name="nome" value="${esc(f.nome)}" placeholder="Cliente o nome impianto" required /></div>
      <div class="field"><label>Tipo di centrale</label><input class="input" name="tipoCentrale" list="tipiCentraleList" value="${esc(f.tipoCentrale)}" placeholder="Es. modello centralina" />
        <datalist id="tipiCentraleList">${tipiEsistenti.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      </div>
      <div class="field"><label>Numero telefonico</label><input class="input" name="numeroTelefonico" value="${esc(f.numeroTelefonico)}" placeholder="Numero SIM / linea impianto" /></div>
      <div class="field"><label>Note</label><textarea class="input" name="note" placeholder="Altre note...">${esc(f.note)}</textarea></div>
      ${f.id ? renderTabellaInterventiImpianto(f.id) : ""}
      <div class="btn-row">
        ${f.id ? `<button type="button" class="btn-danger" data-action="delete-impianto" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">Salva impianto</button>
      </div>
    </form>`;
}

// ============ PREVENTIVI ============
function prossimoNumeroPreventivo() {
  const anno = new Date().getFullYear();
  let max = 0;
  state.preventivi.forEach((p) => {
    const m = /^(\d{3})-(\d{4})$/.exec(p.numero || "");
    if (m && Number(m[2]) === anno) max = Math.max(max, Number(m[1]));
  });
  return `${String(max + 1).padStart(3, "0")}-${anno}`;
}

function renderPreventiviTab() {
  if (state.viewPreventivi === "formCatalogo") return renderFormCatalogo();
  if (state.viewPreventivi === "formPreventivo") return renderFormPreventivo();
  if (state.viewPreventivi === "detail") return renderDetailPreventivo();
  return renderListaPreventiviWrap();
}

function renderListaPreventiviWrap() {
  const valoreCatalogo = state.catalogo.length;
  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Preventivatore</p><h1>Preventivi</h1></div>
        <div class="header-stat"><div class="num">${String(state.preventivi.length).padStart(3, "0")}</div><div class="label">fatti</div></div>
      </div>
    </div>
    <div class="filters">
      <button class="filter-btn ${state.subPreventivi === "elenco" ? "active" : ""}" data-action="sub-preventivi" data-sub="elenco">Elenco preventivi</button>
      <button class="filter-btn ${state.subPreventivi === "catalogo" ? "active" : ""}" data-action="sub-preventivi" data-sub="catalogo">Catalogo (${valoreCatalogo})</button>
    </div>
    ${localStorage.getItem("todo_preventivi_sola_lettura") ? `<p style="font-size:11px;opacity:.6;margin:-8px 0 12px;">&#128274; Solo consultazione (backup leggero da PC) — per crearne di nuovi usa l'app sul PC.</p>` : ""}
    ${state.subPreventivi === "catalogo" ? renderCatalogoLista() : renderElencoPreventivi()}
  `;
}

function renderElencoPreventivi() {
  const ordinati = [...state.preventivi].sort((a, b) => (b.numero || "").localeCompare(a.numero || ""));
  const cards = ordinati.map((p) => `
    <div class="tag-card" data-action="open-preventivo" data-id="${p.id}" role="button" tabindex="0">
      <div class="tag-top">
        <div>
          <p class="tag-date">${fmtData(p.data)} &middot; N&deg; ${esc(p.numero)}</p>
          <p class="tag-title">${esc(p.clienteNome)}</p>
          <p class="tag-sub">${(p.voci || []).length} voci</p>
        </div>
      </div>
      <div class="tag-bottom-row">
        <div class="tag-badges"></div>
        <span class="card-amount">&euro;${euro(p.totale)}</span>
      </div>
    </div>`).join("");
  return `
    ${ordinati.length === 0 ? `<div class="empty"><span class="ico">&#128221;</span><p>Nessun preventivo ancora. Creane uno con il tasto +.</p></div>` : cards}
    ${localStorage.getItem("todo_preventivi_sola_lettura") ? "" : `<button class="fab" data-action="new-preventivo">+</button>`}`;
}

function renderCatalogoLista() {
  const q = state.queryCatalogo.toLowerCase();
  const ordinati = [...state.catalogo].sort((a, b) => a.nome.localeCompare(b.nome));
  const filtered = ordinati.filter((a) => !q || a.nome.toLowerCase().includes(q) || (a.codice || "").toLowerCase().includes(q));
  const cards = filtered.map((a) => `
    <div class="tag-card" data-action="edit-catalogo" data-id="${a.id}" role="button" tabindex="0">
      <div class="tag-top">
        ${a.foto ? `<img class="tag-thumb" src="${a.foto}" alt="" />` : `<div class="tag-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--paper);font-size:18px;">&#128247;</div>`}
        <div style="flex:1;">
          <p class="tag-sub">${esc(a.codice || "")}</p>
          <p class="tag-title">${esc(a.nome)}</p>
        </div>
        <button class="edit-pencil" data-action="edit-catalogo" data-id="${a.id}" aria-label="Modifica">&#9999;&#65039;</button>
      </div>
      <div class="tag-bottom-row"><div class="tag-badges"></div><span class="card-amount">&euro;${euro(a.costoUnitario)}</span></div>
      ${a.descrizione ? `<p class="tag-sub" style="margin-top:6px;">${esc(a.descrizione)}</p>` : ""}
    </div>`).join("");
  return `
    <div class="searchbar"><span>&#128269;</span><input id="searchCatalogo" placeholder="Cerca articolo o codice..." value="${esc(state.queryCatalogo)}" /></div>
    <input type="file" id="importCatalogoInput" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" class="file-input" data-action="noop" />
    <label class="btn-secondary" for="importCatalogoInput" data-action="noop" style="display:block;text-align:center;">Importa catalogo da Excel/CSV</label>
    ${filtered.length === 0 ? `<div class="empty"><span class="ico">&#128230;</span><p>Catalogo vuoto. Aggiungi un articolo col tasto +.</p></div>` : cards}
    ${localStorage.getItem("todo_preventivi_sola_lettura") ? "" : `<button class="fab" data-action="new-catalogo">+</button>`}`;
}

function renderFormCatalogo() {
  const f = state.formArticoloCatalogo || {};
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-preventivi-catalogo">&#8249;</button>
      <h2>${f.id ? "Modifica articolo" : "Nuovo articolo catalogo"}</h2>
    </div>
    <form id="formArticoloCatalogo">
      <div class="field"><label>Foto</label>
        <input type="file" id="fotoCatalogoInput" accept="image/*" class="file-input" data-action="noop" />
        <div class="photo-row" id="fotoCatalogoRow">
          ${f.foto ? `<div class="photo-thumb"><img src="${f.foto}" /><button type="button" class="rm" data-action="rm-foto-catalogo">&#10005;</button></div>` : `<label class="photo-add" for="fotoCatalogoInput" data-action="noop">&#128247;</label>`}
        </div>
      </div>
      <div class="field"><label>Codice</label><input class="input" name="codice" value="${esc(f.codice)}" placeholder="Es. KSI1400016.300" /></div>
      <div class="field"><label>Nome articolo *</label><input class="input" name="nome" value="${esc(f.nome)}" placeholder="Es. Centrale LARES 4 - 16IP" required /></div>
      <div class="field"><label>Descrizione</label><textarea class="input" name="descrizione" placeholder="Dettagli tecnici, caratteristiche, note...">${esc(f.descrizione)}</textarea></div>
      <div class="field"><label>Costo unitario (&euro;)</label><input type="number" step="0.01" class="input" name="costoUnitario" value="${esc(f.costoUnitario)}" placeholder="0.00" /></div>
      <div class="btn-row">
        ${f.id ? `<button type="button" class="btn-danger" data-action="delete-catalogo" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">Salva articolo</button>
      </div>
    </form>`;
}

function renderFormPreventivo() {
  const f = state.formPreventivo || {};
  const voci = f.voci || [];
  const totaleVoci = voci.reduce((s, v) => s + (Number(v.quantita) || 0), 0);
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-preventivi-elenco">&#8249;</button>
      <h2>${f.id ? "Modifica preventivo" : "Nuovo preventivo"}</h2>
    </div>
    <form id="formPreventivo">
      <div class="field"><label>N&deg; preventivo</label><input class="input mono" name="numero" value="${esc(f.numero)}" /></div>
      <div class="field"><label>Data</label><input type="date" class="input" name="data" value="${f.data || oggi()}" /></div>
      <div class="field"><label>Cliente / intestazione *</label><input class="input" name="clienteNome" value="${esc(f.clienteNome)}" placeholder="Nome e cognome cliente" required /></div>
      <div class="field"><label>Indirizzo cliente</label><input class="input" name="clienteIndirizzo" value="${esc(f.clienteIndirizzo)}" placeholder="Facoltativo" /></div>
      <div class="field">
        <label>Testo introduttivo</label>
        <textarea class="input" name="testoIntro" id="testoIntroInput" style="min-height:110px;">${esc(f.testoIntro)}</textarea>
        <button type="button" class="btn-secondary" style="margin-top:8px;" data-action="salva-modello-intro">Salva questo testo come modello</button>
      </div>
      <div class="field">
        <label>Voci del preventivo</label>
        <div class="add-row" style="position:relative;">
          <input class="input" id="voceArticoloInput" autocomplete="off" placeholder="Cerca articolo dal catalogo..." style="flex:2;" />
          <input class="input" id="voceQtaInput" type="number" min="1" step="1" value="1" style="flex:0 0 55px;" />
          <div id="voceSuggestions" class="hidden" style="position:absolute;top:100%;left:0;right:65px;background:var(--card);border:2.5px solid var(--ink);border-radius:10px;box-shadow:4px 4px 0 var(--ink);z-index:30;max-height:220px;overflow-y:auto;margin-top:4px;"></div>
        </div>
        <p style="font-size:11px;opacity:.5;margin:2px 0 8px;">Se il nome corrisponde a un prodotto del catalogo, lo riconosce (icona &#128230;) e prende il costo per il calcolo qui sotto.</p>
        <input class="input" id="voceUbicazioneInput" placeholder="Così ubicati (facoltativo, es. Ingresso, Garage)" style="margin-bottom:8px;" />
        <button type="button" class="btn-secondary" data-action="add-voce-preventivo">Aggiungi voce</button>
        ${voci.some((v) => v.separatore) ? "" : `<button type="button" class="btn-secondary" style="margin-top:6px;" data-action="add-separatore-preventivo">&#8942; Inserisci riga di stop (aggiunte facoltative)</button>`}
        <div id="vociList">${renderVociListHtml(voci)}</div>
        <div id="costoVociBox" style="margin-top:10px;background:var(--paper);border:2px solid var(--ink);border-radius:10px;padding:10px 13px;display:flex;justify-content:space-between;align-items:center;">
          <span class="mono" style="font-size:11px;font-weight:800;opacity:.7;">COSTO MATERIALI (uso interno)</span>
          <span class="mono" id="costoVociTotale" style="font-size:15px;font-weight:900;">&euro;${euro(costoVoci(voci))}</span>
        </div>
        <button type="button" class="btn-secondary" style="margin-top:8px;" data-action="esporta-excel-costi-bozza">&#128202; Esporta Excel costi (bozza)</button>
        <button type="button" class="btn-secondary" data-action="anteprima-pdf-bozza">&#128196; Anteprima PDF (bozza)</button>
      </div>
      <div class="euro-input"><span>&euro;</span><input type="number" step="0.01" name="totale" value="${esc(f.totale)}" placeholder="${voci.some((v) => v.separatore) ? "Totale voci principali" : "Totale finale da presentare al cliente"}" required /></div>
      ${voci.some((v) => v.separatore) ? `<div class="euro-input" style="margin-top:8px;"><span>&euro;</span><input type="number" step="0.01" name="totaleAggiunte" value="${esc(f.totaleAggiunte)}" placeholder="Totale aggiunte facoltative" /></div>` : ""}
      <div class="btn-row">
        ${f.id ? `<button type="button" class="btn-danger" data-action="delete-preventivo" data-id="${f.id}">&#128465;&#65039;</button>` : ""}
        <button type="submit" class="btn-primary">Salva preventivo</button>
      </div>
    </form>`;
}

function renderDetailPreventivo() {
  const p = state.detailPreventivo;
  if (!p) return "";
  return `
    <div class="form-header" style="justify-content:space-between;">
      <button class="back-btn" data-action="back-preventivi-elenco">&#8249;</button>
      <div style="display:flex;gap:8px;">
        <button class="edit-link" data-action="clone-preventivo" data-id="${p.id}">&#128203; Duplica</button>
        <button class="edit-link" data-action="edit-preventivo" data-id="${p.id}">&#9999;&#65039; Modifica</button>
      </div>
    </div>
    <div class="detail-card">
      <p class="tag-date">${fmtData(p.data)} &middot; N&deg; ${esc(p.numero)}</p>
      <h2>${esc(p.clienteNome)}</h2>
      ${p.clienteIndirizzo ? `<p class="tag-sub">${esc(p.clienteIndirizzo)}</p>` : ""}
      ${(() => {
        const voci = p.voci || [];
        const sepIdx = voci.findIndex((v) => v.separatore);
        const principali = sepIdx === -1 ? voci : voci.slice(0, sepIdx);
        const aggiunte = sepIdx === -1 ? [] : voci.slice(sepIdx + 1);
        const rigaVoce = (v) => `<div style="margin:8px 0;"><p style="font-size:13px;margin:0;display:flex;justify-content:space-between;gap:8px;"><span style="font-weight:700;">${esc(v.nome)}</span><span>${esc(v.quantita)}</span></p>${v.descrizione ? `<p style="font-size:12px;opacity:.75;margin:2px 0 0;">${esc(v.descrizione)}</p>` : ""}${v.ubicazione ? `<p style="font-size:12px;opacity:.6;margin:1px 0 0;font-style:italic;">${esc(v.ubicazione)}</p>` : ""}</div>`;
        return `
      <div class="detail-section"><p class="lbl">Voci (${principali.length})</p>
        ${principali.map(rigaVoce).join("")}
      </div>
      <div class="detail-section"><p class="lbl">Totale</p><p style="font-size:20px;font-weight:800;">&euro;${euro(p.totale)}</p></div>
      ${aggiunte.length === 0 ? "" : `
      <div class="detail-section" style="border-top:2px dashed var(--ink);padding-top:10px;">
        <p class="lbl">&#9986;&#65039; Aggiunte facoltative (${aggiunte.length})</p>
        ${aggiunte.map(rigaVoce).join("")}
        <p style="font-size:20px;font-weight:800;margin:6px 0 0;">&euro;${euro(p.totaleAggiunte)}</p>
      </div>`}`;
      })()}
    </div>
    <div class="btn-row" style="margin-top:16px;">
      <button class="btn-danger" style="width:auto;flex:1;color:var(--ink);border-color:var(--border);" data-action="esporta-excel-costi" data-id="${p.id}">&#128202; Excel costi</button>
      <button class="btn-primary" data-action="genera-pdf-preventivo" data-id="${p.id}">PDF cliente</button>
    </div>`;
}

// ============ CASSA ============
function renderCassa() {
  return state.viewCassa === "form" ? renderMovimentoForm() : renderCassaLista();
}

function renderCassaLista() {
  const entrateLavori = calcEntrateLavori();
  const entrateManuali = calcEntrateManuali();
  const usciteTotali = calcUsciteTotali();
  const saldo = entrateLavori + entrateManuali - usciteTotali;

  const righeLavori = state.lavori.filter((j) => !j.remoto && !j.inGaranzia && j.statoPagamento && j.statoPagamento !== "da_pagare").map((j) => ({
    id: "job-" + j.id, data: j.data, tipo: "entrata", origine: "lavoro",
    descrizione: `${j.cliente} — ${j.descrizione}`,
    importo: j.statoPagamento === "pagato" ? (Number(j.importo) || 0) : (Number(j.acconto) || 0),
  }));
  const righe = [...righeLavori, ...state.movimenti].sort((a, b) => (b.data || "").localeCompare(a.data || ""));

  const rowsHtml = righe.map((r) => `
    <div class="movement-row">
      <span class="ico">${r.tipo === "entrata" ? "&#128994;" : "&#128308;"}</span>
      <div class="grow">
        <p class="desc">${esc(r.descrizione)}</p>
        <p class="meta">${fmtData(r.data)} &middot; ${r.origine === "lavoro" ? "lavoretto" : r.origine === "magazzino" ? "acquisto materiali" : "manuale"}</p>
      </div>
      <p class="amount ${r.tipo === "entrata" ? "in" : "out"}">${r.tipo === "entrata" ? "+" : "&minus;"}&euro;${euro(r.importo)}</p>
      ${r.origine !== "lavoro" ? `<button class="del" data-action="delete-movimento" data-id="${r.id}">&#10005;</button>` : ""}
    </div>`).join("");

  return `
    <div class="header">${renderTopbar()}
      <div class="header-row">
        <div><p class="kicker">Saldo attuale</p><h1 style="margin:2px 0 0;">Cassa</h1></div>
        <div class="header-stat"><div class="num" style="color:${saldo < 0 ? "#FF8A8A" : "var(--accent-text)"};font-size:19px;">&euro;${euro(saldo)}</div><div class="label">saldo</div></div>
      </div>
      <div class="balance-row" style="margin-top:14px;">
        <span style="color:#1F5C33;background:rgba(255,255,255,.75);padding:2px 8px;border-radius:6px;">&#8593; &euro;${euro(entrateLavori + entrateManuali)} entrate</span>
        <span style="color:#8A2A20;background:rgba(255,255,255,.75);padding:2px 8px;border-radius:6px;">&#8595; &euro;${euro(usciteTotali)} uscite</span>
      </div>
    </div>
    ${righe.length === 0 ? `<div class="empty"><span class="ico">&#128176;</span><p>Nessun movimento ancora.</p></div>` : `<div>${rowsHtml}</div>`}
    <button class="fab" data-action="new-movimento">+</button>`;
}

function renderMovimentoForm() {
  const f = state.formMovimento || { tipo: "uscita" };
  return `
    <div class="form-header">
      <button class="back-btn" data-action="back-cassa">&#8249;</button>
      <h2>Nuovo movimento</h2>
    </div>
    <form id="formMovimento">
      <div class="field">
        <label>Tipo</label>
        <div class="seg" id="segTipo">
          <button type="button" class="seg-btn ${f.tipo === "uscita" ? "active" : ""}" data-tipo="uscita">Prelievo</button>
          <button type="button" class="seg-btn ${f.tipo === "entrata" ? "active" : ""}" data-tipo="entrata">Versamento</button>
        </div>
        <input type="hidden" name="tipo" id="tipoMovimentoInput" value="${f.tipo}" />
      </div>
      <div class="field"><label>Descrizione *</label><input class="input" name="descrizione" placeholder="Es. carburante, attrezzo, rimborso..." required /></div>
      <div class="field"><label>Importo (&euro;) *</label><input type="number" step="0.01" class="input" name="importo" placeholder="0.00" required /></div>
      <div class="field"><label>Data</label><input type="date" class="input" name="data" value="${oggi()}" /></div>
      <button type="submit" class="btn-primary">Salva movimento</button>
    </form>`;
}

// ---------- backup / restore ----------
function buildBackupPayload() {
  return JSON.stringify({
    app: "TO-DO", version: APP_VERSION, esportatoIl: new Date().toISOString(),
    data: { lavori: state.lavori, articoli: state.articoli, movimenti: state.movimenti, impianti: state.impianti, coda: state.coda, impegni: state.impegni, catalogo: state.catalogo, preventivi: state.preventivi },
  }, null, 2);
}

function provenienza() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Cell" : "PC";
}

function segnaBackupEffettuato() {
  const now = new Date();
  const stamp = `${fmtData(now.toISOString().slice(0, 10))} alle ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  localStorage.setItem("todo_lastBackup", stamp);
  localStorage.setItem("todo_lastBackupTs", String(now.getTime()));
}

function giorniDaUltimoBackup() {
  const ts = localStorage.getItem("todo_lastBackupTs");
  if (!ts) return null;
  return Math.floor((Date.now() - Number(ts)) / 86400000);
}

function haDatiSalvati() {
  return state.lavori.length > 0 || state.articoli.length > 0 || state.impianti.length > 0 || state.coda.length > 0 || state.impegni.length > 0 || state.preventivi.length > 0;
}

function backupInRitardo() {
  if (!haDatiSalvati()) return false;
  const giorni = giorniDaUltimoBackup();
  return giorni === null || giorni >= 3;
}

async function verificaPersistenza(richiedi) {
  const el = document.getElementById("storageStatus");
  if (!el) return;
  if (!navigator.storage || !navigator.storage.persisted) {
    el.textContent = "Il telefono non supporta questa verifica.";
    el.style.color = "";
    return;
  }
  try {
    let persistito = await navigator.storage.persisted();
    if (!persistito && richiedi) {
      persistito = await navigator.storage.persist();
    }
    let quota = "";
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.usage != null && est.quota) {
        const usageMB = (est.usage / 1048576).toFixed(1);
        const quotaMB = (est.quota / 1048576).toFixed(0);
        quota = ` — ${usageMB}MB usati su ${quotaMB}MB disponibili`;
      }
    }
    if (persistito) {
      el.textContent = `✓ Memoria persistente attiva${quota}`;
      el.style.color = "#3A5A4C";
    } else {
      el.textContent = `⚠ Memoria NON persistente${quota} — fai backup regolari`;
      el.style.color = "#B23A2E";
    }
  } catch (e) {
    el.textContent = "Verifica non riuscita.";
    el.style.color = "#B23A2E";
  }
}


async function backupData() {
  const payload = buildBackupPayload();
  const filename = `TO-DO_totale_${provenienza()}_${oggi()}.json`;

  if (window.showSaveFilePicker) {
    // Desktop Chrome/Edge: vera finestra "Salva con nome" per scegliere cartella e nome file
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Backup TO-DO", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
      segnaBackupEffettuato();
      state.backupMsg = "Backup salvato.";
    } catch (e) {
      if (e && e.name !== "AbortError") { console.error(e); state.backupMsg = "Backup non riuscito."; }
      else { render(); return; }
    }
    render();
    setTimeout(() => { state.backupMsg = ""; render(); }, 3000);
    return;
  }

  const file = new File([payload], filename, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    // Telefono: apre il foglio di condivisione nativo — da lì si può "Salva su File/Drive" scegliendo posizione e nome
    try {
      await navigator.share({ files: [file], title: "Backup TO-DO" });
      segnaBackupEffettuato();
      state.backupMsg = "Backup condiviso.";
    } catch (e) {
      if (e && e.name !== "AbortError") { console.error(e); state.backupMsg = "Backup non riuscito."; }
    }
    render();
    setTimeout(() => { state.backupMsg = ""; render(); }, 3000);
    return;
  }

  // fallback: download classico nella cartella Download del telefono/PC
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  segnaBackupEffettuato();
  state.backupMsg = "Backup scaricato nella cartella Download.";
  render();
  setTimeout(() => { state.backupMsg = ""; render(); }, 3000);
}

function applyRestoredData(parsed) {
  const data = parsed.data || parsed;
  localStorage.removeItem("todo_preventivi_sola_lettura");
  state.lavori = data.lavori || [];
  state.articoli = data.articoli || [];
  state.movimenti = data.movimenti || [];
  state.impianti = data.impianti || [];
  state.coda = (data.coda || []).map((c, i) => ({ ...c, ordine: c.ordine != null ? c.ordine : i }));
  state.impegni = data.impegni || [];
  state.catalogo = data.catalogo || [];
  state.preventivi = data.preventivi || [];
  saveArr(KEYS.lavori, state.lavori);
  saveArr(KEYS.articoli, state.articoli);
  saveArr(KEYS.movimenti, state.movimenti);
  saveArr(KEYS.impianti, state.impianti);
  saveArr(KEYS.coda, state.coda);
  saveArr(KEYS.impegni, state.impegni);
  saveArr(KEYS.catalogo, state.catalogo);
  saveArr(KEYS.preventivi, state.preventivi);
}

async function pickAndRestore() {
  if (window.showOpenFilePicker) {
    // Desktop Chrome/Edge: vera finestra "Apri file" per scegliere dove si trova il backup
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Backup TO-DO", accept: { "application/json": [".json"] } }],
      });
      const file = await handle.getFile();
      restoreFromFile(file);
    } catch (e) { /* annullato dall'utente */ }
    return;
  }
  // Telefono: apre comunque il gestore file di sistema (Files/Drive/Download...)
  document.getElementById("restoreInput").click();
}

function restoreFromFile(file) {
  if (!file) return;
  if (!confirm(`Attenzione: questo SOSTITUISCE (non unisce) TUTTI i dati già presenti su questo dispositivo, catalogo e foto compresi, con quelli del file scelto. Tutto quello aggiunto dopo la data di quel backup andrà perso. Continuare?`)) return;
  state.restoring = true;
  render();
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      applyRestoredData(parsed);
      state.backupMsg = "Ripristino completato.";
    } catch (e) {
      state.backupMsg = "Errore nel file di backup.";
    }
    state.restoring = false;
    render();
    setTimeout(() => { state.backupMsg = ""; render(); }, 3000);
  };
  reader.readAsText(file);
}

// ---------- event delegation ----------
root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) {
    if (e.target.closest(".overlay") && !e.target.closest("[data-stop]")) { state.showSettings = false; render(); }
    return;
  }
  const action = el.dataset.action;

  if (action === "set-tab") { state.tab = el.dataset.tab; render(); return; }
  if (action === "open-settings") { state.showSettings = true; render(); verificaPersistenza(false); return; }
  if (action === "close-settings") { state.showSettings = false; render(); return; }
  if (action === "backup") { backupData(); return; }
  if (action === "check-persist") { verificaPersistenza(true); return; }
  if (action === "rinumera-lavori") { rinumeraLavoriPerAnno(); return; }
  if (action === "logout") { if (confirm("Uscire da questo account su questo dispositivo?")) auth.signOut(); return; }

  // LAVORI
  if (action === "new-lavoro") { state.formLavoro = {}; state.viewLavori = "form"; render(); return; }
  if (action === "back-lavori") { state.viewLavori = "lista"; render(); return; }
  if (action === "open-lavoro-detail") { state.detailLavoro = state.lavori.find((j) => j.id === el.dataset.id); state.viewLavori = "dettaglio"; render(); return; }
  if (action === "edit-lavoro") { state.formLavoro = { ...state.lavori.find((j) => j.id === el.dataset.id) }; state.viewLavori = "form"; render(); return; }
  if (action === "delete-lavoro") { state.lavori = state.lavori.filter((j) => j.id !== el.dataset.id); saveArr(KEYS.lavori, state.lavori); state.viewLavori = "lista"; render(); return; }
  if (action === "filter-lavori") { state.filterLavori = el.dataset.filter; render(); return; }
  if (action === "filter-impianti") { state.filterImpianti = el.dataset.filter; render(); return; }

  // DA FARE
  if (action === "add-coda") {
    const inp = document.getElementById("codaInput");
    const v = inp.value.trim();
    if (!v) return;
    state.coda.unshift({ id: uid(), cliente: v, ordine: (state.coda[0] ? state.coda[0].ordine : 0) - 1 });
    saveArr(KEYS.coda, state.coda);
    render();
    return;
  }
  if (action === "delete-coda") { state.coda = state.coda.filter((c) => c.id !== el.dataset.id); saveArr(KEYS.coda, state.coda); render(); return; }

  // PREVENTIVI
  if (action === "sub-preventivi") { state.subPreventivi = el.dataset.sub; render(); return; }
  if (action === "new-catalogo") { state.formArticoloCatalogo = {}; state.viewPreventivi = "formCatalogo"; render(); return; }
  if (action === "edit-catalogo") { state.formArticoloCatalogo = { ...state.catalogo.find((a) => a.id === el.dataset.id) }; state.viewPreventivi = "formCatalogo"; render(); return; }
  if (action === "back-preventivi-catalogo") { state.viewPreventivi = "lista"; state.subPreventivi = "catalogo"; render(); return; }
  if (action === "back-preventivi-elenco") { state.viewPreventivi = "lista"; state.subPreventivi = "elenco"; render(); return; }
  if (action === "delete-catalogo") { state.catalogo = state.catalogo.filter((a) => a.id !== el.dataset.id); saveArr(KEYS.catalogo, state.catalogo); state.viewPreventivi = "lista"; state.subPreventivi = "catalogo"; render(); return; }
  if (action === "rm-foto-catalogo") { state.formArticoloCatalogo.foto = ""; document.getElementById("fotoCatalogoRow").innerHTML = `<label class="photo-add" for="fotoCatalogoInput" data-action="noop">&#128247;</label>`; return; }

  if (action === "new-preventivo") {
    const tmpl = localStorage.getItem("todo_preventivo_template") || "";
    state.formPreventivo = { numero: prossimoNumeroPreventivo(), testoIntro: tmpl, voci: [] };
    state.viewPreventivi = "formPreventivo";
    render();
    return;
  }
  if (action === "edit-preventivo") { state.formPreventivo = { ...state.preventivi.find((p) => p.id === el.dataset.id) }; state.viewPreventivi = "formPreventivo"; render(); return; }
  if (action === "clone-preventivo") {
    const orig = state.preventivi.find((p) => p.id === el.dataset.id);
    if (!orig) return;
    state.formPreventivo = {
      ...orig,
      id: null,
      numero: prossimoNumeroPreventivo(),
      data: oggi(),
      clienteNome: "",
      clienteIndirizzo: "",
      voci: (orig.voci || []).map((v) => ({ ...v })),
    };
    state.viewPreventivi = "formPreventivo";
    render();
    return;
  }
  if (action === "open-preventivo") { state.detailPreventivo = state.preventivi.find((p) => p.id === el.dataset.id); state.viewPreventivi = "detail"; render(); return; }
  if (action === "delete-preventivo") { state.preventivi = state.preventivi.filter((p) => p.id !== el.dataset.id); saveArr(KEYS.preventivi, state.preventivi); state.viewPreventivi = "lista"; render(); return; }
  if (action === "salva-modello-intro") {
    const val = document.getElementById("testoIntroInput").value;
    localStorage.setItem("todo_preventivo_template", val);
    alert("Modello salvato. Verrà proposto nei prossimi preventivi nuovi.");
    return;
  }
  if (action === "add-voce-preventivo") {
    const nomeInp = document.getElementById("voceArticoloInput");
    const qtaInp = document.getElementById("voceQtaInput");
    const ubicInp = document.getElementById("voceUbicazioneInput");
    const nome = nomeInp.value.trim();
    if (!nome) return;
    const art = state.catalogo.find((a) => a.nome.toLowerCase() === nome.toLowerCase());
    state.formPreventivo.voci = [...(state.formPreventivo.voci || []), {
      nome, quantita: Math.max(1, Number(qtaInp.value) || 1), ubicazione: ubicInp.value.trim(), foto: art ? art.foto : "", descrizione: art ? art.descrizione : "",
    }];
    nomeInp.value = ""; qtaInp.value = "1"; ubicInp.value = "";
    refreshVociList();
    return;
  }
  if (action === "add-separatore-preventivo") {
    const vociAttuali = state.formPreventivo.voci || [];
    if (vociAttuali.some((v) => v.separatore)) return;
    state.formPreventivo.voci = [...vociAttuali, { separatore: true, nome: "Aggiunte facoltative" }];
    refreshVociList();
    el.remove();
    const totaleAggInput = document.querySelector('#formPreventivo [name="totaleAggiunte"]');
    if (!totaleAggInput) {
      const totaleInput = document.querySelector('#formPreventivo [name="totale"]');
      totaleInput.placeholder = "Totale voci principali";
      const wrap = document.createElement("div");
      wrap.className = "euro-input";
      wrap.style.marginTop = "8px";
      wrap.innerHTML = `<span>&euro;</span><input type="number" step="0.01" name="totaleAggiunte" placeholder="Totale aggiunte facoltative" />`;
      totaleInput.closest(".euro-input").after(wrap);
    }
    return;
  }
  if (action === "rm-voce-preventivo") {
    const idx = Number(el.dataset.idx);
    const eraSeparatore = state.formPreventivo.voci[idx] && state.formPreventivo.voci[idx].separatore;
    state.formPreventivo.voci.splice(idx, 1);
    refreshVociList();
    if (eraSeparatore) {
      const totaleInput = document.querySelector('#formPreventivo [name="totale"]');
      if (totaleInput) totaleInput.placeholder = "Totale finale da presentare al cliente";
      const totaleAggWrap = document.querySelector('#formPreventivo [name="totaleAggiunte"]')?.closest(".euro-input");
      if (totaleAggWrap) totaleAggWrap.remove();
      const vociListEl = document.getElementById("vociList");
      if (vociListEl && !document.querySelector('[data-action="add-separatore-preventivo"]')) {
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn-secondary"; btn.style.marginTop = "6px";
        btn.dataset.action = "add-separatore-preventivo";
        btn.innerHTML = "&#8942; Inserisci riga di stop (aggiunte facoltative)";
        vociListEl.before(btn);
      }
    }
    return;
  }
  if (action === "voce-up" || action === "voce-down") {
    const idx = Number(el.dataset.idx);
    const voci = state.formPreventivo.voci;
    const swapWith = action === "voce-up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= voci.length) return;
    [voci[idx], voci[swapWith]] = [voci[swapWith], voci[idx]];
    refreshVociList();
    return;
  }
  if (action === "genera-pdf-preventivo") {
    const p = state.preventivi.find((x) => x.id === el.dataset.id);
    if (p) apriPreview("pdf", p);
    return;
  }
  if (action === "esporta-excel-costi") {
    const p = state.preventivi.find((x) => x.id === el.dataset.id);
    if (p) apriPreview("excel", p);
    return;
  }
  if (action === "esporta-excel-costi-bozza") {
    const totaleInput = document.querySelector('#formPreventivo [name="totale"]');
    const clienteInput = document.querySelector('#formPreventivo [name="clienteNome"]');
    const numeroInput = document.querySelector('#formPreventivo [name="numero"]');
    apriPreview("excel", {
      voci: state.formPreventivo.voci || [],
      totale: totaleInput ? totaleInput.value : "",
      clienteNome: clienteInput ? clienteInput.value : "preventivo",
      numero: numeroInput ? numeroInput.value : "",
    });
    return;
  }
  if (action === "anteprima-pdf-bozza") {
    const get = (n) => { const el = document.querySelector(`#formPreventivo [name="${n}"]`); return el ? el.value : ""; };
    apriPreview("pdf", {
      voci: state.formPreventivo.voci || [],
      totale: get("totale"),
      totaleAggiunte: get("totaleAggiunte"),
      clienteNome: get("clienteNome") || "(cliente da inserire)",
      clienteIndirizzo: get("clienteIndirizzo"),
      testoIntro: get("testoIntro"),
      numero: get("numero"),
      data: get("data"),
    });
    return;
  }
  if (action === "close-preview") { state.showPreview = false; render(); return; }
  if (action === "confirm-download-pdf") { generaPdfPreventivo(state.previewData); state.showPreview = false; render(); return; }
  if (action === "invia-pdf-whatsapp") { inviaPdfWhatsapp(state.previewData); return; }
  if (action === "invia-pdf-email") { inviaPdfEmail(state.previewData); return; }
  if (action === "confirm-download-excel") { esportaExcelCosti(state.previewData); state.showPreview = false; render(); return; }

  // IMPEGNI
  if (action === "new-impegno") { state.formImpegno = {}; state.viewImpegni = "form"; render(); return; }
  if (action === "back-impegni") { state.viewImpegni = "lista"; render(); return; }
  if (action === "edit-impegno") { state.formImpegno = { ...state.impegni.find((i) => i.id === el.dataset.id) }; state.viewImpegni = "form"; render(); return; }
  if (action === "delete-impegno") { state.impegni = state.impegni.filter((i) => i.id !== el.dataset.id); saveArr(KEYS.impegni, state.impegni); state.viewImpegni = "lista"; render(); return; }
  if (action === "whatsapp-impegno") { const imp = state.impegni.find((i) => i.id === el.dataset.id); if (imp) inviaImpegnoWhatsapp(imp); return; }
  if (action === "report-coda-whatsapp") { inviaReportCodaWhatsapp(); return; }
  if (action === "coda-up" || action === "coda-down") {
    const idx = state.coda.findIndex((c) => c.id === el.dataset.id);
    const swapWith = action === "coda-up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapWith < 0 || swapWith >= state.coda.length) return;
    [state.coda[idx], state.coda[swapWith]] = [state.coda[swapWith], state.coda[idx]];
    [state.coda[idx].ordine, state.coda[swapWith].ordine] = [state.coda[swapWith].ordine, state.coda[idx].ordine];
    saveArr(KEYS.coda, state.coda);
    render();
    return;
  }
  if (action === "add-materiale") {
    const inp = document.getElementById("materialeInput");
    const qtaInp = document.getElementById("materialeQtaInput");
    const nome = inp.value.trim();
    if (!nome) return;
    const quantita = Math.max(1, Number(qtaInp.value) || 1);
    const articolo = state.articoli.find((a) => a.nome.toLowerCase() === nome.toLowerCase());
    let articoloId = null;
    if (articolo) {
      articolo.quantita = (Number(articolo.quantita) || 0) - quantita;
      saveArr(KEYS.articoli, state.articoli);
      articoloId = articolo.id;
    }
    state.formLavoro.materiali = [...(state.formLavoro.materiali || []), { nome, quantita, articoloId }];
    refreshMaterialiChips();
    inp.value = "";
    qtaInp.value = "1";
    inp.focus();
    return;
  }
  if (action === "rm-materiale") {
    const idx = Number(el.dataset.idx);
    const entry = state.formLavoro.materiali[idx];
    if (entry && typeof entry === "object" && entry.articoloId) {
      const articolo = state.articoli.find((a) => a.id === entry.articoloId);
      if (articolo) { articolo.quantita = (Number(articolo.quantita) || 0) + entry.quantita; saveArr(KEYS.articoli, state.articoli); }
    }
    state.formLavoro.materiali.splice(idx, 1);
    refreshMaterialiChips();
    return;
  }
  if (action === "rm-foto") {
    const idx = Number(el.dataset.idx);
    state.formLavoro.foto.splice(idx, 1);
    renderFotoRow();
    return;
  }

  // MAGAZZINO
  if (action === "new-articolo") { state.formArticolo = {}; state.isCorrezione = false; state.viewMagazzino = "form"; render(); return; }
  if (action === "back-magazzino") { state.viewMagazzino = "lista"; render(); return; }
  if (action === "edit-articolo") { state.formArticolo = { ...state.articoli.find((a) => a.id === el.dataset.id) }; state.isCorrezione = true; state.viewMagazzino = "form"; render(); return; }
  if (action === "delete-articolo") {
    state.articoli = state.articoli.filter((a) => a.id !== el.dataset.id);
    saveArr(KEYS.articoli, state.articoli);
    state.movimenti = state.movimenti.filter((m) => m.articoloId !== el.dataset.id);
    saveArr(KEYS.movimenti, state.movimenti);
    state.viewMagazzino = "lista";
    render();
    return;
  }

  // IMPIANTI
  if (action === "new-impianto") { state.formImpianto = {}; state.viewImpianti = "form"; render(); return; }
  if (action === "back-impianti") { state.viewImpianti = "lista"; render(); return; }
  if (action === "edit-impianto") { state.formImpianto = { ...state.impianti.find((i) => i.id === el.dataset.id) }; state.viewImpianti = "form"; render(); return; }
  if (action === "delete-impianto") { state.impianti = state.impianti.filter((i) => i.id !== el.dataset.id); saveArr(KEYS.impianti, state.impianti); state.viewImpianti = "lista"; render(); return; }

  // CASSA
  if (action === "new-movimento") { state.formMovimento = { tipo: "uscita" }; state.viewCassa = "form"; render(); return; }
  if (action === "back-cassa") { state.viewCassa = "lista"; render(); return; }
  if (action === "delete-movimento") { state.movimenti = state.movimenti.filter((m) => m.id !== el.dataset.id); saveArr(KEYS.movimenti, state.movimenti); render(); return; }
});

// segmented controls (payment status / movement type / garanzia checkbox) — DOM-only, no full re-render
root.addEventListener("click", (e) => {
  const sugg = e.target.closest(".voce-suggestion");
  if (sugg) {
    document.getElementById("voceArticoloInput").value = sugg.dataset.nome;
    document.getElementById("voceSuggestions").classList.add("hidden");
    document.getElementById("voceQtaInput").focus();
    return;
  }
  if (!e.target.closest("#voceArticoloInput") && !e.target.closest("#voceSuggestions")) {
    const box = document.getElementById("voceSuggestions");
    if (box) box.classList.add("hidden");
  }
  const seg = e.target.closest("#segPagamento .seg-btn");
  if (seg) {
    document.querySelectorAll("#segPagamento .seg-btn").forEach((b) => b.classList.remove("active"));
    seg.classList.add("active");
    document.getElementById("statoPagamentoInput").value = seg.dataset.stato;
    document.getElementById("accontoRow").style.display = seg.dataset.stato === "acconto" ? "" : "none";
    return;
  }
  const segT = e.target.closest("#segTipo .seg-btn");
  if (segT) {
    document.querySelectorAll("#segTipo .seg-btn").forEach((b) => b.classList.remove("active"));
    segT.classList.add("active");
    document.getElementById("tipoMovimentoInput").value = segT.dataset.tipo;
    return;
  }
});

root.addEventListener("change", (e) => {
  if (e.target.id === "deviceLabelInput") {
    const val = e.target.value.trim();
    localStorage.setItem("todo_device_label", val || (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Cellulare" : "PC"));
    return;
  }
  if (e.target.id === "inGaranziaCheck") {
    document.getElementById("garanziaScadenzaInput").style.display = e.target.checked ? "" : "none";
    togglePagamentoSection();
    return;
  }
  if (e.target.id === "remotoCheck") { togglePagamentoSection(); return; }
  if (e.target.id === "restoreInput") { restoreFromFile(e.target.files[0]); return; }

  if (e.target.id === "importCsvInput") { importaCSV(e.target.files[0]); e.target.value = ""; return; }
  if (e.target.id === "importCatalogoInput") { importaCatalogoFile(e.target.files[0]); e.target.value = ""; return; }
  if (e.target.id === "fotoCatalogoInput") {
    const file = e.target.files[0];
    if (!file) return;
    resizeImage(file, 500, 0.6).then((dataUrl) => {
      state.formArticoloCatalogo.foto = dataUrl;
      document.getElementById("fotoCatalogoRow").innerHTML = `<div class="photo-thumb"><img src="${dataUrl}" /><button type="button" class="rm" data-action="rm-foto-catalogo">&#10005;</button></div>`;
    });
    e.target.value = "";
    return;
  }
  if (e.target.id === "importImpiantiInput") { importaImpiantiFile(e.target.files[0]); e.target.value = ""; return; }
  if (e.target.id === "fotoInput") {
    const file = e.target.files[0];
    if (!file) return;
    resizeImage(file, 640, 0.6).then((dataUrl) => {
      state.formLavoro.foto = [...(state.formLavoro.foto || []), dataUrl];
      renderFotoRow();
    });
    e.target.value = "";
  }
});

function refreshMaterialiChips() {
  const materiali = state.formLavoro.materiali || [];
  document.getElementById("materialiChips").outerHTML = `<div class="chip-row" id="materialiChips">${materiali.map((m, i) => `<span class="chip">${esc(typeof m === "string" ? m : m.nome)}${typeof m === "object" && m.quantita > 1 ? " ×" + m.quantita : ""}${typeof m === "object" && m.articoloId ? " &#128230;" : ""}<span class="rm" data-action="rm-materiale" data-idx="${i}">&#10005;</span></span>`).join("")}</div>`;
}

function togglePagamentoSection() {
  const remoto = document.getElementById("remotoCheck").checked;
  const garanzia = document.getElementById("inGaranziaCheck").checked;
  document.getElementById("pagamentoSection").style.display = (remoto || garanzia) ? "none" : "";
  document.getElementById("materialiSection").style.display = remoto ? "none" : "";
}

function costoVoci(voci) {
  return (voci || []).reduce((s, v) => {
    const art = state.catalogo.find((a) => a.nome.toLowerCase() === v.nome.toLowerCase());
    const costoUn = art ? Number(art.costoUnitario) || 0 : 0;
    return s + costoUn * (Number(v.quantita) || 0);
  }, 0);
}

function renderVociListHtml(voci) {
  return (voci || []).map((v, i) => {
    if (v.separatore) {
      return `
      <div class="movement-row" style="background:var(--paper);border:2px dashed var(--ink);align-items:center;">
        <div class="grow" style="text-align:center;"><p class="desc" style="font-weight:800;letter-spacing:.5px;">&#9986;&#65039; &mdash; STOP: da qui in gi&ugrave; sono AGGIUNTE facoltative &mdash;</p></div>
        <button class="del" data-action="rm-voce-preventivo" data-idx="${i}">&#10005;</button>
      </div>`;
    }
    const matched = state.catalogo.some((a) => a.nome.toLowerCase() === v.nome.toLowerCase());
    return `
    <div class="movement-row">
      <div class="reorder">
        <button type="button" class="reorder-btn" data-action="voce-up" data-idx="${i}" ${i === 0 ? "disabled" : ""}>&#9650;</button>
        <button type="button" class="reorder-btn" data-action="voce-down" data-idx="${i}" ${i === voci.length - 1 ? "disabled" : ""}>&#9660;</button>
      </div>
      ${v.foto ? `<img src="${v.foto}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;flex-shrink:0;" />` : ""}
      <div class="grow"><p class="desc">${esc(v.quantita)} &times; ${esc(v.nome)}${matched ? " &#128230;" : ""}</p><p class="meta">${esc(v.ubicazione || "")}</p></div>
      <button class="del" data-action="rm-voce-preventivo" data-idx="${i}">&#10005;</button>
    </div>`;
  }).join("");
}

function refreshVociList() {
  const voci = state.formPreventivo.voci || [];
  const listEl = document.getElementById("vociList");
  if (listEl) listEl.innerHTML = renderVociListHtml(voci);
  const totEl = document.getElementById("costoVociTotale");
  if (totEl) totEl.textContent = `€${euro(costoVoci(voci))}`;
}

function renderFotoRow() {
  const foto = state.formLavoro.foto || [];
  document.getElementById("fotoRow").innerHTML = `
    ${foto.map((src, i) => `<div class="photo-thumb"><img src="${src}" /><button type="button" class="rm" data-action="rm-foto" data-idx="${i}">&#10005;</button></div>`).join("")}
    <label class="photo-add" for="fotoInput" data-action="noop">&#128247;</label>`;
}

// live search (input, not click)
root.addEventListener("input", (e) => {
  if (e.target.id === "clienteLavoroInput") {
    const match = document.getElementById("clienteImpiantoMatch");
    if (!match) return;
    const trovato = state.impianti.some((i) => i.nome.toLowerCase() === e.target.value.trim().toLowerCase());
    if (trovato) {
      match.textContent = "✅ Collegato all'impianto registrato con questo nome.";
      match.style.cssText = "font-size:11px;margin:4px 0 0;color:#1F5C33;font-weight:700;";
    } else {
      match.textContent = "Se il nome corrisponde a un impianto già registrato, l'intervento viene collegato a quella scheda.";
      match.style.cssText = "font-size:11px;margin:4px 0 0;opacity:.5;";
    }
    return;
  }
  if (e.target.id === "voceArticoloInput") {
    const q = e.target.value.trim().toLowerCase();
    const box = document.getElementById("voceSuggestions");
    if (!box) return;
    if (!q) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const match = state.catalogo.filter((a) => a.nome.toLowerCase().includes(q)).slice(0, 8);
    if (match.length === 0) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    box.innerHTML = match.map((a) => `
      <div class="voce-suggestion" data-nome="${esc(a.nome)}" style="padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;">
        <span style="font-size:13px;font-weight:700;">${esc(a.nome)}</span>
        <span class="mono" style="font-size:11px;opacity:.6;flex-shrink:0;">&euro;${euro(a.costoUnitario)}</span>
      </div>`).join("");
    box.classList.remove("hidden");
    return;
  }
  if (e.target.id === "searchLavori") { state.queryLavori = e.target.value; renderListOnlyLavori(); }
  if (e.target.id === "searchMagazzino") { state.queryMagazzino = e.target.value; renderListOnlyMagazzino(); }
  if (e.target.id === "searchImpianti") { state.queryImpianti = e.target.value; renderListOnlyImpianti(); }
  if (e.target.id === "filterSelectLavori") { state.filterLavori = e.target.value; render(); }
  if (e.target.id === "filterSelectImpianti") { state.filterImpianti = e.target.value; render(); }
  if (e.target.id === "searchCatalogo") { state.queryCatalogo = e.target.value; renderListOnlyCatalogo(); }
  if (e.target.id === "searchImpegni") { state.queryImpegni = e.target.value; renderListOnlyImpegni(); }
  if (e.target.classList && e.target.classList.contains("date-it")) {
    const el = e.target;
    const prevPos = el.selectionStart == null ? el.value.length : el.selectionStart;
    const digitsBeforeCursor = el.value.slice(0, prevPos).replace(/\D/g, "").length;
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += "/" + digits.slice(2, 4);
    if (digits.length > 4) out += "/" + digits.slice(4, 8);
    el.value = out;
    let count = 0, newPos = out.length;
    for (let i = 0; i < out.length; i++) {
      if (/\d/.test(out[i])) count++;
      if (count === digitsBeforeCursor) { newPos = i + 1; break; }
    }
    if (digitsBeforeCursor === 0) newPos = 0;
    el.setSelectionRange(newPos, newPos);
  }
});
// Simpler & robust: full re-render on search too, but preserve focus by re-focusing the input after render.
function renderListOnlyLavori() { const pos = getCaret(); render(); restoreFocus("searchLavori", pos); }
function renderListOnlyMagazzino() { const pos = getCaret(); render(); restoreFocus("searchMagazzino", pos); }
function renderListOnlyImpianti() { const pos = getCaret(); render(); restoreFocus("searchImpianti", pos); }
function renderListOnlyCatalogo() { const pos = getCaret(); render(); restoreFocus("searchCatalogo", pos); }
function renderListOnlyImpegni() { const pos = getCaret(); render(); restoreFocus("searchImpegni", pos); }
function getCaret() { const el = document.activeElement; return el && el.selectionStart != null ? el.selectionStart : null; }
function restoreFocus(id, pos) { const el = document.getElementById(id); if (el) { el.focus(); if (pos != null) el.setSelectionRange(pos, pos); } }

// form submits
root.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);

  if (form.id === "formLogin") {
    const email = (fd.get("email") || "").trim();
    const password = fd.get("password") || "";
    state.authError = "";
    state.authLoading = true;
    render();
    auth.signInWithEmailAndPassword(email, password).catch((err) => {
      state.authLoading = false;
      state.authError = err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found"
        ? "Email o password non corrette."
        : "Accesso non riuscito: " + err.message;
      render();
    });
    return;
  }

  if (form.id === "formLavoro") {
    const prev = state.formLavoro || {};
    const remoto = document.getElementById("remotoCheck").checked;
    const inGaranzia = document.getElementById("inGaranziaCheck").checked;
    const senzaPagamento = remoto || inGaranzia;
    const job = {
      id: prev.id || uid(),
      numeroIntervento: (fd.get("numeroIntervento") || "").trim() || prossimoNumeroIntervento(),
      cliente: (fd.get("cliente") || "").trim(),
      telefono: (fd.get("telefono") || "").trim(),
      descrizione: (fd.get("descrizione") || "").trim(),
      data: fd.get("data") || oggi(),
      remoto,
      importo: senzaPagamento ? "" : (fd.get("importo") || ""),
      statoPagamento: senzaPagamento ? "" : (fd.get("statoPagamento") || "da_pagare"),
      acconto: senzaPagamento ? "" : (fd.get("acconto") || ""),
      materiali: prev.materiali || [],
      foto: prev.foto || [],
      inGaranzia,
      garanziaScadenza: inGaranzia ? (fd.get("garanziaScadenza") || "") : "",
      note: (fd.get("note") || "").trim(),
    };
    const impiantoAssociato = state.impianti.find((i) => i.nome.toLowerCase() === job.cliente.toLowerCase());
    job.impiantoId = impiantoAssociato ? impiantoAssociato.id : "";
    if (!job.cliente || !job.descrizione) return;
    const idx = state.lavori.findIndex((j) => j.id === job.id);
    if (idx >= 0) state.lavori[idx] = job; else state.lavori.unshift(job);
    state.lavori.sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    saveArr(KEYS.lavori, state.lavori);
    state.viewLavori = "lista";
    render();
    return;
  }

  if (form.id === "formArticolo") {
    const nome = (fd.get("nome") || "").trim();
    const quantita = Number(fd.get("quantita")) || 0;
    const costoUnitario = Number(fd.get("costoUnitario")) || 0;
    const fornitore = (fd.get("fornitore") || "").trim();
    const dataUltimoCarico = (fd.get("dataUltimoCarico") || "").trim() || fmtData(oggi());
    if (!nome || fd.get("quantita") === "") return;

    if (state.isCorrezione) {
      const idx = state.articoli.findIndex((a) => a.id === state.formArticolo.id);
      if (idx >= 0) state.articoli[idx] = { ...state.articoli[idx], quantita, costoUnitario, fornitore, dataUltimoCarico };
      saveArr(KEYS.articoli, state.articoli);
    } else {
      const esistente = state.articoli.find((a) => a.nome.toLowerCase() === nome.toLowerCase());
      let articoloId;
      const nuovoCarico = { data: dataUltimoCarico, quantita, costoUnitario, fornitore };
      if (esistente) {
        esistente.quantita = (Number(esistente.quantita) || 0) + quantita;
        esistente.costoUnitario = costoUnitario;
        esistente.fornitore = fornitore;
        esistente.dataUltimoCarico = dataUltimoCarico;
        esistente.storicoCarichi = [...(esistente.storicoCarichi || []), nuovoCarico];
        articoloId = esistente.id;
      } else {
        articoloId = uid();
        state.articoli.push({ id: articoloId, nome, quantita, costoUnitario, fornitore, dataUltimoCarico, storicoCarichi: [nuovoCarico] });
      }
      saveArr(KEYS.articoli, state.articoli);
      state.movimenti.unshift({
        id: uid(), tipo: "uscita", origine: "magazzino", articoloId, data: itToIso(dataUltimoCarico) || oggi(),
        descrizione: `Acquisto ${quantita} × ${nome}${fornitore ? " da " + fornitore : ""}`,
        importo: quantita * costoUnitario,
      });
      saveArr(KEYS.movimenti, state.movimenti);
    }
    state.viewMagazzino = "lista";
    render();
    return;
  }

  if (form.id === "formImpianto") {
    const prev = state.formImpianto || {};
    const impianto = {
      id: prev.id || uid(),
      numeroImpianto: (fd.get("numeroImpianto") || "").trim(),
      dataImpianto: (fd.get("dataImpianto") || "").trim(),
      nome: (fd.get("nome") || "").trim(),
      tipoCentrale: (fd.get("tipoCentrale") || "").trim(),
      numeroTelefonico: (fd.get("numeroTelefonico") || "").trim(),
      note: (fd.get("note") || "").trim(),
    };
    if (!impianto.nome) return;
    const idx = state.impianti.findIndex((i) => i.id === impianto.id);
    if (idx >= 0) state.impianti[idx] = impianto; else state.impianti.unshift(impianto);
    saveArr(KEYS.impianti, state.impianti);
    state.viewImpianti = "lista";
    render();
    return;
  }

  if (form.id === "formImpegno") {
    const prev = state.formImpegno || {};
    const impegno = {
      id: prev.id || uid(),
      numeroImpegno: (fd.get("numeroImpegno") || "").trim(),
      data: fd.get("data") || oggi(),
      ora: (fd.get("ora") || "").trim(),
      cliente: (fd.get("cliente") || "").trim(),
      luogo: (fd.get("luogo") || "").trim(),
      note: (fd.get("note") || "").trim(),
    };
    if (!impegno.cliente) return;
    const idx = state.impegni.findIndex((i) => i.id === impegno.id);
    if (idx >= 0) state.impegni[idx] = impegno; else state.impegni.unshift(impegno);
    saveArr(KEYS.impegni, state.impegni);
    state.viewImpegni = "lista";
    render();
    return;
  }

  if (form.id === "formArticoloCatalogo") {
    const prev = state.formArticoloCatalogo || {};
    const articolo = {
      id: prev.id || uid(),
      codice: (fd.get("codice") || "").trim(),
      nome: (fd.get("nome") || "").trim(),
      descrizione: (fd.get("descrizione") || "").trim(),
      costoUnitario: fd.get("costoUnitario") || "",
      foto: prev.foto || "",
    };
    if (!articolo.nome) return;
    const idx = state.catalogo.findIndex((a) => a.id === articolo.id);
    if (idx >= 0) state.catalogo[idx] = articolo; else state.catalogo.unshift(articolo);
    saveArr(KEYS.catalogo, state.catalogo);
    state.viewPreventivi = "lista"; state.subPreventivi = "catalogo";
    render();
    return;
  }

  if (form.id === "formPreventivo") {
    const prev = state.formPreventivo || {};
    const preventivo = {
      id: prev.id || uid(),
      numero: (fd.get("numero") || "").trim() || prossimoNumeroPreventivo(),
      data: fd.get("data") || oggi(),
      clienteNome: (fd.get("clienteNome") || "").trim(),
      clienteIndirizzo: (fd.get("clienteIndirizzo") || "").trim(),
      testoIntro: fd.get("testoIntro") || "",
      voci: prev.voci || [],
      totale: fd.get("totale") || "",
      totaleAggiunte: fd.get("totaleAggiunte") || "",
    };
    if (!preventivo.clienteNome) return;
    const idx = state.preventivi.findIndex((p) => p.id === preventivo.id);
    if (idx >= 0) state.preventivi[idx] = preventivo; else state.preventivi.unshift(preventivo);
    saveArr(KEYS.preventivi, state.preventivi);
    state.viewPreventivi = "lista"; state.subPreventivi = "elenco";
    render();
    return;
  }

  if (form.id === "formMovimento") {
    const movimento = {
      id: uid(), tipo: fd.get("tipo") || "uscita", origine: "manuale",
      descrizione: (fd.get("descrizione") || "").trim(), importo: Number(fd.get("importo")) || 0,
      data: fd.get("data") || oggi(),
    };
    if (!movimento.descrizione || fd.get("importo") === "") return;
    state.movimenti.unshift(movimento);
    saveArr(KEYS.movimenti, state.movimenti);
    state.viewCassa = "lista";
    render();
    return;
  }
});

// nasconde la barra in basso e il tasto + mentre si scorre verso il basso, li rimostra scorrendo su
let lastScrollY = window.scrollY;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const delta = y - lastScrollY;
  const nav = document.querySelector(".bottom-nav");
  const fab = document.querySelector(".fab");
  if (y < 40) {
    nav && nav.classList.remove("nav-hidden");
    fab && fab.classList.remove("nav-hidden");
  } else if (delta > 8) {
    nav && nav.classList.add("nav-hidden");
    fab && fab.classList.add("nav-hidden");
  } else if (delta < -8) {
    nav && nav.classList.remove("nav-hidden");
    fab && fab.classList.remove("nav-hidden");
  }
  lastScrollY = y;
}, { passive: true });

// autenticazione: mostra login finché non arriva una sessione valida,
// poi avvia la sincronizzazione in tempo reale con Firestore
auth.onAuthStateChanged((user) => {
  state.authUser = user;
  state.authLoading = false;
  if (user) avviaSincronizzazioneRealtime();
  render();
});

// initial render
render();

root.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "codaInput") { e.preventDefault(); document.querySelector('[data-action="add-coda"]').click(); }
  if (e.target.id === "materialeInput") { e.preventDefault(); document.querySelector('[data-action="add-materiale"]').click(); }
  if (e.target.matches('[role="button"]')) { e.preventDefault(); e.target.click(); }
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.error("SW error", e));
  });
}
