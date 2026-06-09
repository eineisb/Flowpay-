const http = require("http");
const { ethers } = require("ethers");

const PORT       = process.env.PORT || 3000;
const RPCS = [
  "https://5042002.rpc.thirdweb.com",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network"
];
const CHAIN_ID     = 5042002;
const FLOWPAY_ADDR = "0x0Fd6e2e7Aff8363Cb57A60f5Cee17209C72EA156";
const PRIVATE_KEY  = process.env.PRIVATE_KEY;
const CHECK_EVERY  = 60 * 1000; // every minute

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);

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
    let executed = 0, checked = 0, due = 0;
    for (let id = 1; id <= 50; id++) {
      try {
        const streamData = await call(iface.encodeFunctionData("getStream", [id]));
        const [stream] = iface.decodeFunctionResult("getStream", streamData);
        if (Number(stream.id) === 0) break;
        checked++;
        if (!stream.active) { console.log(`[${time}] Stream ${id} (${stream.label}): inactive`); continue; }
        const checkerData = await call(iface.encodeFunctionData("checker", [id]));
        const [canExec] = iface.decodeFunctionResult("checker", checkerData);
        if (canExec) {
          console.log(`[${time}] Stream ${id} (${stream.label}): executing...`);
          const txHash = await sendTx(iface.encodeFunctionData("executePayment", [id]));
          console.log(`[${time}] Stream ${id}: tx ${txHash}`);
          executed++;
        } else {
          const nextDueData = await call(iface.encodeFunctionData("nextDueTime", [id]));
          const [nextDue] = iface.decodeFunctionResult("nextDueTime", nextDueData);
          const mins = Math.ceil((Number(nextDue) - now) / 60);
          console.log(`[${time}] Stream ${id} (${stream.label}): due in ${mins}min`);
          due++;
        }
      } catch(e) { break; }
    }
    if (checked === 0) { lastResult = "No streams found"; console.log(`[${time}] No streams found`); }
    else { lastResult = executed > 0 ? `Executed ${executed} payment(s)` : `${checked} stream(s) checked, ${due} pending`; }
  } catch(e) {
    lastResult = `Error: ${e.message}`;
    console.error(`[${time}] Check failed: ${e.message}`);
  }
  lastCheck = new Date().toISOString();
}

// HTTP server — keeps Render alive + shows status
const server = http.createServer((req, res) => {
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
