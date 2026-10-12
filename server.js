const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get("/healthz", (req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const COLORS = ["red", "blue", "green", "yellow"];
const FRC = { red: "rouge", blue: "bleu", green: "vert", yellow: "jaune" };
const MAX_PLAYERS = 8;
const AFK_MS = 25000;          // un joueur déconnecté est passé automatiquement après 25 s
const LOBBY_GRACE_MS = 30000;  // délai avant de retirer un joueur déconnecté du salon
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ---------- Cartes ---------- */
let cardSeq = 0;
const mk = (color, value) => ({ id: "c" + (++cardSeq), color, value });

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Jeu officiel : 108 cartes (76 numéros, 24 actions de couleur, 8 jokers)
function newDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push(mk(c, "0"));
    for (let n = 1; n <= 9; n++) d.push(mk(c, String(n)), mk(c, String(n)));
    for (const v of ["+2", "SKIP", "REVERSE"]) d.push(mk(c, v), mk(c, v));
  }
  for (let i = 0; i < 4; i++) d.push(mk("wild", "WILD"), mk("wild", "WILD4"));
  return shuffle(d);
}
function points(c) {
  if (c.color === "wild") return 50;
  return /^\d$/.test(c.value) ? Number(c.value) : 20;
}
function label(c) {
  const v = { SKIP: "Passe", REVERSE: "Inversion", WILD: "Joker", WILD4: "Joker +4" }[c.value] || c.value;
  return c.color === "wild" ? v : v + " " + FRC[c.color];
}

/* ---------- Utilitaires ---------- */
const cleanName = n => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 18) || "Joueur";
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}
const topCard = r => r.discard[r.discard.length - 1] || null;
const curPlayer = r => r.players[r.current];
function nextIndex(r, from, n = 1) {
  const c = r.players.length;
  return (((from + r.direction * n) % c) + c) % c;
}
function say(r, msg) { r.log.push(msg); if (r.log.length > 30) r.log.shift(); }
function canPlay(r, card) {
  const t = topCard(r);
  return card.color === "wild" || card.color === r.activeColor || (t.color !== "wild" && card.value === t.value);
}
function drawOne(r) {
  if (r.deck.length === 0) {
    if (r.discard.length <= 1) return null;
    const t = r.discard.pop();
    r.deck = shuffle(r.discard);
    r.discard = [t];
  }
  return r.deck.pop() || null;
}
function giveCards(r, p, n) {
  for (let i = 0; i < n; i++) {
    const c = drawOne(r);
    if (c) p.hand.push(c);
  }
  p.saidUno = false;
}

/* ---------- État envoyé aux clients ---------- */
function stateFor(r, me) {
  const playing = r.status === "playing";
  const cur = playing ? curPlayer(r) : null;
  const myTurn = !!cur && cur.id === me.id;
  const pend = r.pending;
  const mustRespond = !!pend && r.players[pend.target].id === me.id;
  const canAct = myTurn && !pend;
  const hand = me.hand.map(c => ({
    ...c,
    playable: canAct && (r.drawnCard ? c.id === r.drawnCard.id && canPlay(r, c) : canPlay(r, c))
  }));
  return {
    code: r.code,
    status: r.status,
    hostId: r.hostId,
    isHost: me.id === r.hostId,
    players: r.players.map((p, i) => ({
      id: p.id, name: p.name, count: p.hand.length, score: p.score, connected: p.connected, isBot: !!p.isBot,
      uno: p.hand.length === 1 && p.saidUno,
      isCurrent: playing && i === r.current
    })),
    current: r.current,
    direction: r.direction,
    top: topCard(r),
    activeColor: r.activeColor,
    deckCount: r.deck.length,
    winnerId: r.winnerId,
    roundPoints: r.roundPoints,
    log: r.log.slice(-4),
    canCatch: !!r.vulnerable && r.vulnerable !== me.id,
    pending: pend ? {
      fromName: r.players[pend.from].name,
      targetName: r.players[pend.target].name,
      mine: mustRespond
    } : null,
    me: {
      id: me.id, name: me.name, myTurn,
      canDraw: canAct && !r.drawnCard,
      canPass: canAct && !!r.drawnCard,
      canUno: playing && !me.saidUno && me.hand.length > 0 && me.hand.length <= 2,
      hand
    }
  };
}
function sendRoom(r) {
  r.last = Date.now();
  for (const p of r.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", stateFor(r, p));
  }
}

/* ---------- Tours ---------- */
function bump(r) {
  r.turnId++;
  clearTimeout(r.afkTimer);
  clearTimeout(r.botTimer);
  if (r.status !== "playing") return;
  const actor = r.pending ? r.players[r.pending.target] : curPlayer(r);
  if (!actor) return;
  if (actor.isBot) scheduleBot(r);
  else if (!actor.connected) scheduleAfk(r, actor);
}
function scheduleAfk(r, actor) {
  clearTimeout(r.afkTimer);
  const id = r.turnId;
  r.afkTimer = setTimeout(() => {
    if (r.status !== "playing" || r.turnId !== id || actor.connected) return;
    say(r, actor.name + " est absent : son tour est passé.");
    if (r.pending) acceptDraw4(r);
    else { giveCards(r, actor, 1); advanceTurn(r); }
    sendRoom(r);
  }, AFK_MS);
}
function advanceTurn(r, n = 1) {
  r.current = nextIndex(r, r.current, n);
  r.drawnCard = null;
  bump(r);
}
function acceptDraw4(r) {
  const pend = r.pending;
  const target = r.players[pend.target];
  giveCards(r, target, 4);
  say(r, target.name + " pioche 4 cartes et passe son tour.");
  r.pending = null;
  r.current = nextIndex(r, pend.target);
  r.drawnCard = null;
  bump(r);
}
function finishRound(r, winner) {
  const pts = r.players.reduce((s, p) => s + p.hand.reduce((a, c) => a + points(c), 0), 0);
  winner.score += pts;
  r.status = "finished";
  r.winnerId = winner.id;
  r.roundPoints = pts;
  r.pending = null;
  r.drawnCard = null;
  r.vulnerable = null;
  clearTimeout(r.afkTimer);
  clearTimeout(r.botTimer);
  say(r, winner.name + " gagne la manche et marque " + pts + " points !");
}
function startRound(r) {
  const n = r.players.length;
  r.deck = newDeck();
  r.discard = [];
  r.pending = null;
  r.drawnCard = null;
  r.vulnerable = null;
  r.winnerId = null;
  r.roundPoints = 0;
  r.direction = 1;
  r.players.forEach(p => { p.hand = []; p.saidUno = false; });
  for (let i = 0; i < 7; i++) r.players.forEach(p => p.hand.push(drawOne(r)));
  let first = drawOne(r);
  while (first.color === "wild") { r.deck.unshift(first); first = drawOne(r); }
  r.discard.push(first);
  r.activeColor = first.color;
  r.starter = ((r.starter ?? -1) + 1) % n;
  r.current = r.starter;
  r.status = "playing";
  r.log = [];
  say(r, "La manche commence. La carte de départ est " + label(first) + ".");
  if (first.value === "+2") {
    giveCards(r, curPlayer(r), 2);
    say(r, curPlayer(r).name + " pioche 2 cartes et passe son tour.");
    r.current = nextIndex(r, r.current);
  } else if (first.value === "SKIP") {
    say(r, curPlayer(r).name + " passe son tour.");
    r.current = nextIndex(r, r.current);
  } else if (first.value === "REVERSE") {
    r.direction = -1;
    r.current = nextIndex(r, r.current);
    say(r, "Le sens du jeu est inversé.");
  }
  bump(r);
}

/* ---------- Salons ---------- */
function removePlayer(r, p) {
  const i = r.players.indexOf(p);
  if (i === -1) return;
  r.players.splice(i, 1);
  if (!r.players.some(x => !x.isBot)) { clearTimeout(r.afkTimer); clearTimeout(r.botTimer); rooms.delete(r.code); return; }
  if (r.hostId === p.id) r.hostId = r.players.find(x => !x.isBot).id;
  if (r.status === "finished" && r.players.length < 2) r.status = "lobby";
  say(r, p.name + " a quitté le salon.");
  sendRoom(r);
}

/* ---------- Actions (partagées entre humains et bots) ---------- */
function doPlay(room, p, cardId, color) {
  if (room.status !== "playing") return "La partie n’a pas commencé.";
  if (room.pending) return "Une décision sur le +4 est en attente.";
  if (curPlayer(room).id !== p.id) return "Ce n’est pas ton tour.";
  const idx = p.hand.findIndex(c => c.id === cardId);
  const card = p.hand[idx];
  if (!card) return "Carte introuvable.";
  if (room.drawnCard && room.drawnCard.id !== card.id) return "Tu dois jouer la carte piochée ou passer.";
  if (!canPlay(room, card)) return "Cette carte ne peut pas être jouée.";
  if (card.color === "wild" && !COLORS.includes(color)) return "Choisis une couleur pour le joker.";

  if (room.vulnerable && room.vulnerable !== p.id) room.vulnerable = null;
  const prevColor = room.activeColor;
  const bluff = card.value === "WILD4" && p.hand.some(c => c.color === prevColor);

  p.hand.splice(idx, 1);
  room.discard.push(card);
  room.activeColor = card.color === "wild" ? color : card.color;
  room.drawnCard = null;
  say(room, p.name + " joue " + label(card) + (card.color === "wild" ? " → " + FRC[color] : "") + ".");

  // Dernière carte : les pioches de la carte jouée s'appliquent, puis la manche se termine
  if (p.hand.length === 0) {
    const nxt = room.players[nextIndex(room, room.current)];
    if (card.value === "+2") giveCards(room, nxt, 2);
    if (card.value === "WILD4") giveCards(room, nxt, 4);
    finishRound(room, p);
    return;
  }
  if (p.hand.length > 1) p.saidUno = false;
  else if (p.saidUno) say(room, p.name + " crie UNO !");
  else { room.vulnerable = p.id; say(room, p.name + " n’a plus qu’une carte !"); scheduleBotCatch(room, p); }

  if (card.value === "+2") {
    const t = nextIndex(room, room.current);
    giveCards(room, room.players[t], 2);
    say(room, room.players[t].name + " pioche 2 cartes et passe son tour.");
    room.current = nextIndex(room, t);
    bump(room);
  } else if (card.value === "SKIP") {
    say(room, room.players[nextIndex(room, room.current)].name + " passe son tour.");
    advanceTurn(room, 2);
  } else if (card.value === "REVERSE") {
    room.direction *= -1;
    say(room, "Le sens du jeu est inversé.");
    if (room.players.length === 2) bump(room); // à deux, inversion = rejouer
    else advanceTurn(room);
  } else if (card.value === "WILD4") {
    const t = nextIndex(room, room.current);
    room.pending = { from: room.current, target: t, legal: !bluff };
    room.current = t;
    say(room, room.players[t].name + " peut défier le +4 ou piocher 4 cartes.");
    bump(room);
  } else advanceTurn(room);
}
function doDraw(room, p) {
  if (room.status !== "playing") return "La partie n’a pas commencé.";
  if (room.pending) return "Une décision sur le +4 est en attente.";
  if (curPlayer(room).id !== p.id) return "Ce n’est pas ton tour.";
  if (room.drawnCard) return "Tu as déjà pioché : joue la carte ou passe.";
  if (room.vulnerable && room.vulnerable !== p.id) room.vulnerable = null;
  const card = drawOne(room);
  if (!card) { say(room, "Plus de cartes à piocher."); advanceTurn(room); return; }
  p.hand.push(card);
  p.saidUno = false;
  if (canPlay(room, card)) {
    room.drawnCard = card;
    say(room, p.name + " pioche une carte.");
  } else {
    say(room, p.name + " pioche et passe son tour.");
    advanceTurn(room);
  }
}
function doPass(room, p) {
  if (room.status !== "playing" || room.pending) return "Action impossible.";
  if (curPlayer(room).id !== p.id) return "Ce n’est pas ton tour.";
  if (!room.drawnCard) return "Pioche d’abord une carte.";
  if (room.vulnerable && room.vulnerable !== p.id) room.vulnerable = null;
  say(room, p.name + " passe son tour.");
  advanceTurn(room);
}
function doChallenge(room, p) {
  if (room.status !== "playing" || !room.pending) return;
  const pend = room.pending;
  if (room.players[pend.target].id !== p.id) return;
  const from = room.players[pend.from];
  room.pending = null;
  if (!pend.legal) {
    giveCards(room, from, 4);
    say(room, p.name + " défie " + from.name + " : le +4 était illégal ! " + from.name + " pioche 4 cartes.");
    bump(room); // le joueur qui a défié joue normalement
  } else {
    giveCards(room, p, 6);
    say(room, p.name + " défie " + from.name + " mais le +4 était légal : " + p.name + " pioche 6 cartes.");
    room.current = nextIndex(room, pend.target);
    bump(room);
  }
}
function doAccept(room, p) {
  if (room.status !== "playing" || !room.pending) return;
  if (room.players[room.pending.target].id !== p.id) return;
  acceptDraw4(room);
}
function doCatch(room, catcher) {
  if (room.status !== "playing" || !room.vulnerable || room.vulnerable === catcher.id) return false;
  const v = room.players.find(x => x.id === room.vulnerable);
  room.vulnerable = null;
  if (!v || v.hand.length !== 1) return false;
  giveCards(room, v, 2);
  say(room, catcher.name + " a surpris " + v.name + " sans UNO ! " + v.name + " pioche 2 cartes.");
  return true;
}

/* ---------- Bots ---------- */
const BOT_NAMES = ["Robo", "Pixel", "Turbo", "Nova", "Zig", "Bolt", "Echo", "Dash"];
function scheduleBot(r) {
  clearTimeout(r.botTimer);
  const id = r.turnId;
  r.botTimer = setTimeout(() => botMove(r, id), 900 + crypto.randomInt(900));
}
function botColor(b, card) {
  const n = { red: 0, blue: 0, green: 0, yellow: 0 };
  b.hand.forEach(c => { if (c.id !== card.id && c.color !== "wild") n[c.color]++; });
  const best = Math.max(...Object.values(n));
  const top = COLORS.filter(c => n[c] === best);
  return top[crypto.randomInt(top.length)];
}
function botPick(pool) {
  const plain = pool.filter(c => c.color !== "wild").sort((a, b) => points(b) - points(a));
  if (plain.length) return plain[0];
  return pool.find(c => c.value === "WILD") || pool[0];
}
function botMove(r, id) {
  if (r.status !== "playing" || r.turnId !== id) return;
  const b = r.pending ? r.players[r.pending.target] : curPlayer(r);
  if (!b || !b.isBot) return;
  if (r.pending) {
    if (crypto.randomInt(100) < 20) doChallenge(r, b); else doAccept(r, b);
    return sendRoom(r);
  }
  if (!r.drawnCard && !b.hand.some(c => canPlay(r, c))) {
    doDraw(r, b);
    sendRoom(r);
    if (r.status === "playing" && r.drawnCard) {
      const tid = r.turnId;
      r.botTimer = setTimeout(() => botMove(r, tid), 800);
    }
    return;
  }
  const pool = r.drawnCard ? [r.drawnCard] : b.hand.filter(c => canPlay(r, c));
  const card = botPick(pool);
  if (b.hand.length === 2 && crypto.randomInt(100) < 85) b.saidUno = true; // un bot oublie parfois
  doPlay(r, b, card.id, card.color === "wild" ? botColor(b, card) : undefined);
  sendRoom(r);
}
function scheduleBotCatch(r, victim) {
  r.players.forEach(b => {
    if (!b.isBot || b === victim) return;
    setTimeout(() => {
      if (r.vulnerable === victim.id && crypto.randomInt(100) < 50 && doCatch(r, b)) sendRoom(r);
    }, 1500 + crypto.randomInt(1500));
  });
}

io.on("connection", socket => {
  const err = msg => socket.emit("errorMessage", msg);
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const p = room && room.players.find(x => x.token === socket.data.token);
    return room && p ? { room, p } : {};
  };
  const on = (name, fn) => socket.on(name, payload => {
    const now = Date.now();
    const hits = (socket.data.hits = (socket.data.hits || []).filter(t => now - t < 1000));
    hits.push(now);
    if (hits.length > 20) return;
    try { fn(payload && typeof payload === "object" ? payload : {}); } catch (e) { console.error(e); }
  });
  const attach = (room, p) => {
    clearTimeout(p.timer);
    p.socketId = socket.id;
    p.connected = true;
    socket.data.code = room.code;
    socket.data.token = p.token;
    socket.join(room.code);
    socket.emit("joined", { code: room.code, token: p.token });
  };
  const newPlayer = name => ({
    id: crypto.randomBytes(4).toString("hex"), token: crypto.randomBytes(16).toString("hex"),
    socketId: null, name: cleanName(name), hand: [], score: 0, connected: true, saidUno: false, timer: null
  });

  on("createRoom", ({ name }) => {
    const code = makeCode();
    const p = newPlayer(name);
    const room = {
      code, hostId: p.id, players: [p], status: "lobby", deck: [], discard: [],
      current: 0, direction: 1, activeColor: null, winnerId: null, roundPoints: 0,
      pending: null, drawnCard: null, vulnerable: null, log: [], turnId: 0,
      afkTimer: null, botTimer: null, last: Date.now()
    };
    say(room, "Salon créé. Invite tes amis avec le code.");
    rooms.set(code, room);
    attach(room, p);
    sendRoom(room);
  });

  on("joinRoom", ({ code, name }) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return err("Code de salon introuvable.");
    if (room.status === "playing") return err("Cette partie a déjà commencé.");
    if (room.players.length >= MAX_PLAYERS) return err("Ce salon est complet (" + MAX_PLAYERS + " joueurs maximum).");
    const p = newPlayer(name);
    room.players.push(p);
    attach(room, p);
    say(room, p.name + " a rejoint le salon.");
    sendRoom(room);
  });

  on("rejoin", ({ code, token }) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && room.players.find(x => x.token === token);
    if (!p) return socket.emit("sessionExpired");
    attach(room, p);
    say(room, p.name + " est de retour.");
    if (room.status === "playing") bump(room);
    sendRoom(room);
  });

  on("startGame", () => {
    const { room, p } = ctx();
    if (!room) return;
    if (p.id !== room.hostId) return err("Seul l’hôte peut lancer la partie.");
    if (room.status === "playing") return;
    if (room.players.length < 2) return err("Il faut au moins 2 joueurs.");
    startRound(room);
    sendRoom(room);
  });

  const act = fn => () => { const { room, p } = ctx(); if (!room) return; fn(room, p); };
  on("playCard", ({ cardId, color }) => {
    const { room, p } = ctx();
    if (!room) return;
    const e = doPlay(room, p, cardId, color);
    if (e) return err(e);
    sendRoom(room);
  });
  on("drawCard", () => {
    const { room, p } = ctx();
    if (!room) return;
    const e = doDraw(room, p);
    if (e) return err(e);
    sendRoom(room);
  });
  on("passTurn", () => {
    const { room, p } = ctx();
    if (!room) return;
    const e = doPass(room, p);
    if (e) return err(e);
    sendRoom(room);
  });
  on("challenge", act((room, p) => { doChallenge(room, p); sendRoom(room); }));
  on("acceptDraw4", act((room, p) => { doAccept(room, p); sendRoom(room); }));

  on("callUno", () => {
    const { room, p } = ctx();
    if (!room || room.status !== "playing") return;
    if (room.vulnerable === p.id) {
      room.vulnerable = null;
      p.saidUno = true;
      say(room, p.name + " crie UNO !");
    } else if (p.hand.length > 0 && p.hand.length <= 2 && !p.saidUno) {
      p.saidUno = true;
    } else return;
    sendRoom(room);
  });

  on("catchUno", act((room, p) => { if (doCatch(room, p)) sendRoom(room); }));

  on("addBot", () => {
    const { room, p } = ctx();
    if (!room || p.id !== room.hostId || room.status === "playing") return;
    if (room.players.length >= MAX_PLAYERS) return err("Ce salon est complet.");
    const used = new Set(room.players.map(x => x.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || "Bot" + crypto.randomInt(100);
    room.players.push({
      id: crypto.randomBytes(4).toString("hex"), token: crypto.randomBytes(16).toString("hex"),
      socketId: null, name, hand: [], score: 0, connected: true, saidUno: false, timer: null, isBot: true
    });
    say(room, name + " (bot) a rejoint le salon.");
    sendRoom(room);
  });

  on("removeBot", ({ id }) => {
    const { room, p } = ctx();
    if (!room || p.id !== room.hostId || room.status === "playing") return;
    const b = room.players.find(x => x.id === id && x.isBot);
    if (!b) return;
    room.players.splice(room.players.indexOf(b), 1);
    if (room.status === "finished" && room.players.length < 2) room.status = "lobby";
    say(room, b.name + " a quitté le salon.");
    sendRoom(room);
  });

  on("leaveRoom", () => {
    const { room, p } = ctx();
    if (!room || room.status === "playing") return;
    socket.leave(room.code);
    socket.data.code = null;
    socket.data.token = null;
    socket.emit("left");
    removePlayer(room, p);
  });

  socket.on("disconnect", () => {
    const { room, p } = ctx();
    if (!room || p.socketId !== socket.id) return;
    p.connected = false;
    if (room.players.filter(x => !x.isBot).every(x => !x.connected)) { room.last = Date.now() - ROOM_TTL_MS + 10 * 60 * 1000; }
    if (room.status === "playing") {
      say(room, p.name + " s’est déconnecté. Il peut revenir avec le même navigateur.");
      bump(room);
    } else {
      p.timer = setTimeout(() => { if (!p.connected) removePlayer(room, p); }, LOBBY_GRACE_MS);
    }
    sendRoom(room);
  });
});

// Nettoyage des salons inactifs
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.last > ROOM_TTL_MS) { clearTimeout(r.afkTimer); clearTimeout(r.botTimer); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Play Together est disponible sur http://localhost:" + PORT));
