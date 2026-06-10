const http = require("http");
const { ethers } = require("ethers");

const PORT       = process.env.PORT || 3000;
const RPCS = [
  "https://5042002.rpc.thirdweb.com",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network"
];
const CHAIN_ID     = 5042002;
const FLOWPAY_ADDR = "0x15d396BC2499463cD719A32229a9B1419381B814";
const PRIVATE_KEY  = process.env.PRIVATE_KEY;
const CHECK_EVERY  = 60 * 1000; // every minute

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);
const paymentHistory = {};

const iface = new ethers.Interface([
  "function getUserStreams(address) view returns (uint256[])",
  "function checker(uint256) view returns (bool canExec, bytes execPayload)",
  "function executePayment(uint256)",
  "function nextDueTime(uint256) view returns (uint256)",
  "function getStream(uint256) view returns (tuple(uint256 id,address sender,address recipient,uint256 amountPerInterval,uint8 interval,uint256 startTime,uint256 lastExecuted,uint256 totalDeposited,uint256 totalPaid,bool active,string label,uint256 createdAt))"
]);

async function rpc(method, params, idx = 0) {
  if (idx >= RPCS.length) throw new Error("All RPCs failed");
  try {
    const res = await fetch(RPCS[idx], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } catch(e) {
    return rpc(method, params, idx + 1);
  }
}

async function call(data) {
  return rpc("eth_call", [{ to: FLOWPAY_ADDR, data }, "latest"]);
}

async function sendTx(data) {
  const [nonce, gasPrice] = await Promise.all([
    rpc("eth_getTransactionCount", [wallet.address, "latest"]),
    rpc("eth_gasPrice", [])
  ]);
  const signed = await wallet.signTransaction({
    to: FLOWPAY_ADDR, data, nonce, gasPrice,
    gasLimit: "0x493E0",
    chainId: "0x" + CHAIN_ID.toString(16)
  });
  return rpc("eth_sendRawTransaction", [signed]);
}

let lastCheck = null;
let lastResult = "Starting...";

async function checkAndExecute() {
  const now = Math.floor(Date.now() / 1000);
  const time = new Date().toLocaleTimeString();
  try {
    // Fetch all stream data in parallel
    const ids = Array.from({length:50},(_,i)=>i+1);
    const streamResults = await Promise.all(ids.map(id =>
      call(iface.encodeFunctionData("getStream",[id])).then(d => {
        const [s] = iface.decodeFunctionResult("getStream",d);
        return s;
      }).catch(()=>null)
    ));

    const streams = streamResults.filter(s => s && Number(s.id) > 0);

    if(!streams.length){
      lastResult = "No streams found";
      console.log(`[${time}] No streams found`);
      lastCheck = new Date().toISOString();
      return;
    }

    const activeStreams = streams.filter(s => s.active);

    if(!activeStreams.length){
      streams.forEach(s => console.log(`[${time}] Stream ${s.id} (${s.label}): inactive`));
      lastResult = `${streams.length} stream(s) checked - all inactive`;
      lastCheck = new Date().toISOString();
      return;
    }

    // Check all active streams in parallel
    const checkerResults = await Promise.all(activeStreams.map(s =>
      call(iface.encodeFunctionData("checker",[s.id])).then(d => {
        const [canExec] = iface.decodeFunctionResult("checker",d);
        return {stream: s, canExec};
      }).catch(()=>({stream: s, canExec: false}))
    ));

    const dueStreams = checkerResults.filter(r => r.canExec);
    const pendingStreams = checkerResults.filter(r => !r.canExec);

    // Get next due times for pending streams in parallel
    const dueTimes = await Promise.all(pendingStreams.map(r =>
      call(iface.encodeFunctionData("nextDueTime",[r.stream.id])).then(d => {
        const [due] = iface.decodeFunctionResult("nextDueTime",d);
        return {stream: r.stream, mins: Math.ceil((Number(due)-now)/60)};
      }).catch(()=>({stream: r.stream, mins: 0}))
    ));

    // Log inactive
    streams.filter(s=>!s.active).forEach(s =>
      console.log(`[${time}] Stream ${s.id} (${s.label}): inactive`)
    );

    // Log pending
    dueTimes.forEach(({stream,mins}) =>
      console.log(`[${time}] Stream ${stream.id} (${stream.label}): due in ${mins}min`)
    );

    // Execute due payments
    let executed = 0;
    for(const {stream} of dueStreams){
      try{
        console.log(`[${time}] Stream ${stream.id} (${stream.label}): executing...`);
        const txHash = await sendTx(iface.encodeFunctionData("executePayment",[stream.id]));
        console.log(`[${time}] Stream ${stream.id}: tx ${txHash}`);
        if(!paymentHistory[stream.id]) paymentHistory[stream.id] = [];
        paymentHistory[stream.id].unshift({amount:Number(stream.amountPerInterval)/1e6,timestamp:Date.now(),txHash});
        executed++;
      }catch(e){
        console.error(`[${time}] Stream ${stream.id}: ${e.message}`);
      }
    }

    lastResult = executed > 0
      ? `Executed ${executed} payment(s)`
      : `${streams.length} stream(s) checked, ${dueStreams.length} due, ${pendingStreams.length} pending`;

  }catch(e){
    lastResult = `Error: ${e.message}`;
    console.error(`[${time}] Check failed: ${e.message}`);
  }
  lastCheck = new Date().toISOString();
}

// HTTP server — keeps Render alive + shows status
const server = http.createServer((req, res) => {
  if(req.url.startsWith("/history/")){
    const id=req.url.split("/")[2];
    res.writeHead(200,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify(paymentHistory[id]||[]));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "running",
    wallet: wallet.address,
    contract: FLOWPAY_ADDR,
    lastCheck,
    lastResult,
    uptime: Math.floor(process.uptime()) + "s"
  }));
});

server.listen(PORT, () => {
  console.log(`FlowPay Keeper server running on port ${PORT}`);
  console.log(`Wallet: ${wallet.address}`);
});

// Self-ping to prevent Render spin-down
setInterval(async () => {
  try {
    await fetch('https://flowpay-wks2.onrender.com');
    console.log('Self-ping OK');
  } catch(e) {}
}, 10 * 60 * 1000);

// Run keeper loop
async function loop() {
  while (true) {
    await checkAndExecute();
    await new Promise(r => setTimeout(r, CHECK_EVERY));
  }
}

loop().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
