const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = "https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=50&tableId=39791215743193&curPage=1";
const MONGO = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/sicbo";

// ===== DB =====
mongoose.connect(MONGO);

const Result = mongoose.model("Result", new mongoose.Schema({
  phien: { type: String, unique: true },
  ket_qua: String,
  tong: Number,
  time: Number
}));

// ===== RAM =====
let lastPhien = null;
let lastData = null;

// ===== UTILS =====
const phanLoai = s => (s >= 11 ? "Tài" : "Xỉu");

const format = i => ({
  phien: i.gameNum,
  tong: i.score,
  ket_qua: phanLoai(i.score),
  xuc_xac: i.facesList,
  md5: i.md5,
  time: i.timeMilli
});

// ===== SAVE DB =====
async function save(item) {
  await Result.updateOne({ phien: item.phien }, item, { upsert: true });
}

// ===== MARKOV =====
async function markov() {
  const d = await Result.find().sort({ time: 1 }).limit(300);

  let m = { Tài: { Tài: 0, Xỉu: 0 }, Xỉu: { Tài: 0, Xỉu: 0 } };

  for (let i = 1; i < d.length; i++) {
    m[d[i - 1].ket_qua][d[i].ket_qua]++;
  }

  let last = d[d.length - 1]?.ket_qua || "Tài";
  let next = m[last].Tài > m[last].Xỉu ? "Tài" : "Xỉu";

  let total = m[last].Tài + m[last].Xỉu;
  let conf = total ? ((m[last][next] / total) * 100).toFixed(2) : 50;

  return { du_doan: next, do_tin_cay: conf + "%" };
}

// ===== PHÂN TÍCH CẦU =====
function phanTich(history) {
  let arr = history.map(i => i.ket_qua);

  // cầu bệt
  let bet = 1;
  for (let i = arr.length - 1; i > 0; i--) {
    if (arr[i] === arr[i - 1]) bet++;
    else break;
  }

  // cầu 1-1
  let alt = true;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1]) alt = false;
  }

  return {
    cau_bet: bet,
    cau_1_1: alt,
    chuoi_6: arr.slice(-6).join(" ")
  };
}

// ===== CẢNH BÁO =====
function canhBao(pt) {
  if (pt.cau_bet >= 4) return "⚠️ Bệt mạnh → theo cầu";
  if (pt.cau_1_1) return "⚠️ Cầu 1-1 → đánh đảo";
  return "✅ Bình thường";
}

// ===== FETCH REALTIME =====
async function fetchData() {
  try {
    const { data } = await axios.get(API_URL);
    const list = data?.data?.resultList || [];
    if (!list.length) return;

    const history = list.slice(0, 20).map(format);
    const current = history[0];

    // CHỐNG TRÙNG
    if (current.phien === lastPhien) return;

    lastPhien = current.phien;

    await save(current);

    const ai = await markov();
    const pt = phanTich(history);

    lastData = {
      status: true,
      tag: "@vanminh2603",

      phien_hien_tai: current,

      ai_markov: ai,

      phan_tich_cau: pt,

      canh_bao: canhBao(pt),

      lich_su: history
    };

    // WS broadcast
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify(lastData));
      }
    });

    console.log("NEW:", current.phien);

  } catch (e) {
    console.log("ERR:", e.message);
  }
}

// ===== API =====
app.get("/sicbo", (req, res) => {
  if (!lastData) {
    return res.json({ status: false, message: "Đợi realtime..." });
  }
  res.json(lastData);
});

// ===== STREAM JSON =====
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Transfer-Encoding", "chunked");

  const send = () => {
    if (lastData) {
      res.write(JSON.stringify(lastData) + "\n");
    }
  };

  const interval = setInterval(send, 2000);

  req.on("close", () => clearInterval(interval));
});

// ===== SERVER =====
const server = app.listen(PORT, () => {
  console.log("🚀 RUN:", PORT);
});

const wss = new WebSocket.Server({ server });

// ===== LOOP =====
setInterval(fetchData, 2000);
