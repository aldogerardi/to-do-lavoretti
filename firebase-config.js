"use strict";

// Configurazione del progetto Firebase "to-do-lavoretti"
const firebaseConfig = {
  apiKey: "AIzaSyBVgbPXzsphZVtKa7P05pX42hU9mOh545g",
  authDomain: "to-do-lavoretti.firebaseapp.com",
  projectId: "to-do-lavoretti",
  storageBucket: "to-do-lavoretti.firebasestorage.app",
  messagingSenderId: "807192955941",
  appId: "1:807192955941:web:8a3c671fefb11c80fdc3cc",
  measurementId: "G-LW2J8997ZE",
};

firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();

// Cache locale: permette di aprire/consultare l'app anche senza connessione
// e mette in coda le modifiche fatte offline, inviandole appena torna la rete.
try {
  db.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn("Persistenza offline non attiva:", e.code));
} catch (e) { /* non supportato su questo browser */ }

// Resta collegato tra una visita e l'altra (niente login ad ogni apertura)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((e) => console.warn(e));
