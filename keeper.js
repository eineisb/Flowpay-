const { ethers } = require("ethers");

const RPCS = [
  "https://5042002.rpc.thirdweb.com",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network"
];
const CHAIN_ID     = 5042002;
const FLOWPAY_ADDR = "0xC839285AC88A2446B6D22172870cb36c592bCE94";
const PRIVATE_KEY  = process.env.PRIVATE_KEY;
const CHECK_EVERY  = 3 * 60 * 1000;

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);

const iface = new ethers.Interface([
  "function getUserStreams(address) view returns (uint256[])",
  "function checker(uint256) view returns (bool canExec, bytes execPayload)",
  "function executePayment(uint256)",
  "function nextDueTime(uint256) view returns (uint256)"
]);

async function rpc(method, params, rpcIndex = 0) {
  if (rpcIndex >= RPCS.length) throw new Error("All RPCs failed");
  try {
    const res = await fetch(RPCS[rpcIndex], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } catch(e) {
    console.warn(`  RPC ${RPCS[rpcIndex]} failed: ${e.message} — trying next...`);
    return rpc(method, params, rpcIndex + 1);
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
  const tx = {
    to: FLOWPAY_ADDR,
    data,
    nonce,
    gasPrice,
    gasLimit: "0x493E0",
    chainId: "0x" + CHAIN_ID.toString(16)
  };
  const signed = await wallet.signTransaction(tx);
  return rpc("eth_sendRawTransaction", [signed]);
}

async function checkAndExecute() {
  const now = Math.floor(Date.now() / 1000);
  console.log(`\n[${new Date().toLocaleTimeString()}] Checking streams...`);
  try {
    const streamsData = await call(iface.encodeFunctionData("getUserStreams", [wallet.address]));
    const ids = iface.decodeFunctionResult("getUserStreams", streamsData)[0];
    if (!ids.length) { console.log("  No streams found."); return; }

    for (const id of ids) {
      try {
        const checkerData = await call(iface.encodeFunctionData("checker", [id]));
        const [canExec] = iface.decodeFunctionResult("checker", checkerData);

        if (!canExec) {
          const dueData = await call(iface.encodeFunctionData("nextDueTime", [id]));
          const [due] = iface.decodeFunctionResult("nextDueTime", dueData);
          const secsLeft = Number(due) - now;
          console.log(`  Stream ${id}: due in ${secsLeft > 0 ? Math.ceil(secsLeft/60)+"min" : "inactive/low balance"}`);
          continue;
        }

        console.log(`  Stream ${id}: DUE — executing...`);
        const txHash = await sendTx(iface.encodeFunctionData("executePayment", [id]));
        console.log(`  Stream ${id}: tx ${txHash}`);
        console.log(`  Stream ${id}: payment sent`);

      } catch(e) {
        console.error(`  Stream ${id}: ${e.message}`);
      }
    }
  } catch(e) {
    console.error(`  Check failed: ${e.message}`);
  }
}

const ONCE = process.argv.includes("--once");
async function loop() {
  console.log("FlowPay Keeper started");
  console.log("Wallet :", wallet.address);
  console.log("RPCs   :", RPCS.join(", "));
  console.log("Interval: every 3 minutes\n");

  if (ONCE) { await checkAndExecute(); process.exit(0); }
  while (true) {
    await checkAndExecute();
    await new Promise(r => setTimeout(r, CHECK_EVERY));
  }
}

loop().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
