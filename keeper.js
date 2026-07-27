const { ethers } = require("ethers");

const RPCS = [
  "https://rpc.blockdaemon.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://5042002.rpc.thirdweb.com"
];
const CHAIN_ID     = 5042002;
const FLOWPAY_ADDR = "0xaF8f43eCbAc5844e16e780634273072676347cA2";
const PRIVATE_KEY  = process.env.PRIVATE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = 'eineisb/Flowpay-';
const HISTORY_PATH = 'history.json';

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);
let paymentHistory = {};
let historySha = null;

const iface = new ethers.Interface([
  "function getUserStreams(address) view returns (uint256[])",
  "function checker(uint256) view returns (bool canExec, bytes execPayload)",
  "function executePayment(uint256)",
  "function nextDueTime(uint256) view returns (uint256)",
  "function getStream(uint256) view returns (tuple(uint256 id,address sender,address recipient,uint256 amountPerInterval,uint8 interval,uint256 startTime,uint256 lastExecuted,uint256 totalDeposited,uint256 totalPaid,bool active,string label,uint256 createdAt))"
]);

async function loadHistory() {
  if (!GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${HISTORY_PATH}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (res.ok) {
      const data = await res.json();
      historySha = data.sha;
      paymentHistory = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      console.log('Loaded history:', Object.keys(paymentHistory).length, 'stream(s)');
    }
  } catch(e) { console.log('No history file yet'); }
}

async function saveHistory() {
  if (!GITHUB_TOKEN) return;
  try {
    const content = Buffer.from(JSON.stringify(paymentHistory)).toString('base64');
    const body = { message: 'update: payment history', content, branch: 'main' };
    if (historySha) body.sha = historySha;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${HISTORY_PATH}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.content) historySha = data.content.sha;
  } catch(e) { console.error('History save failed:', e.message); }
}

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
    rpc("eth_getTransactionCount", [wallet.address, "pending"]),
    rpc("eth_gasPrice", [])
  ]);
  const signed = await wallet.signTransaction({
    to: FLOWPAY_ADDR, data, nonce, gasPrice,
    gasLimit: "0x493E0",
    chainId: "0x" + CHAIN_ID.toString(16)
  });
  return rpc("eth_sendRawTransaction", [signed]);
}

async function checkAndExecute() {
  const now = Math.floor(Date.now() / 1000);
  const time = new Date().toLocaleTimeString();

  const ids = Array.from({length:50},(_,i)=>i+1);
  const streamResults = await Promise.all(ids.map(id =>
    call(iface.encodeFunctionData("getStream",[id])).then(d => {
      const [s] = iface.decodeFunctionResult("getStream",d);
      return s;
    }).catch(()=>null)
  ));

  const streams = streamResults.filter(s => s && Number(s.id) > 0);

  if(!streams.length){
    console.log(`[${time}] No streams found`);
    return;
  }

  const activeStreams = streams.filter(s => s.active);

  if(!activeStreams.length){
    streams.forEach(s => console.log(`[${time}] Stream ${s.id} (${s.label}): inactive`));
    return;
  }

  const checkerResults = await Promise.all(activeStreams.map(s =>
    call(iface.encodeFunctionData("checker",[s.id])).then(d => {
      const [canExec] = iface.decodeFunctionResult("checker",d);
      return {stream: s, canExec};
    }).catch(()=>({stream: s, canExec: false}))
  ));

  const dueStreams = checkerResults.filter(r => r.canExec);
  const pendingStreams = checkerResults.filter(r => !r.canExec);

  const dueTimes = await Promise.all(pendingStreams.map(r =>
    call(iface.encodeFunctionData("nextDueTime",[r.stream.id])).then(d => {
      const [due] = iface.decodeFunctionResult("nextDueTime",d);
      return {stream: r.stream, mins: Math.ceil((Number(due)-now)/60)};
    }).catch(()=>({stream: r.stream, mins: 0}))
  ));

  streams.filter(s=>!s.active).forEach(s =>
    console.log(`[${time}] Stream ${s.id} (${s.label}): inactive`)
  );

  dueTimes.forEach(({stream,mins}) =>
    console.log(`[${time}] Stream ${stream.id} (${stream.label}): due in ${mins}min`)
  );

  let executed = 0;
  for(const {stream} of dueStreams){
    try{
      console.log(`[${time}] Stream ${stream.id} (${stream.label}): executing...`);
      const txHash = await sendTx(iface.encodeFunctionData("executePayment",[stream.id]));
      console.log(`[${time}] Stream ${stream.id}: tx ${txHash}`);
      const historyKey = FLOWPAY_ADDR + '-' + stream.id;
      if(!paymentHistory[historyKey]) paymentHistory[historyKey] = [];
      paymentHistory[historyKey].unshift({amount:Number(stream.amountPerInterval)/1e6,timestamp:Date.now(),txHash});
      await saveHistory();
      executed++;
    }catch(e){
      console.error(`[${time}] Stream ${stream.id}: ${e.message}`);
    }
  }

  console.log(executed > 0
    ? `Executed ${executed} payment(s)`
    : `${streams.length} stream(s) checked, ${dueStreams.length} due, ${pendingStreams.length} pending`);
}

(async () => {
  await loadHistory();
  await checkAndExecute();
  console.log("Keeper run complete");
  process.exit(0);
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
