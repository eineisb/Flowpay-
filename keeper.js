const { ethers } = require("ethers");

const RPCS = [
  "https://5042002.rpc.thirdweb.com",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network"
];
const CHAIN_ID     = 5042002;
const FLOWPAY_ADDR = "0xe5EAF959d19F2009e66e91a31D86BFdD3A8eafA2";
const PRIVATE_KEY  = process.env.PRIVATE_KEY;
const CHECK_EVERY  = 1 * 60 * 1000;
const ONCE         = process.argv.includes("--once");

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);

const iface = new ethers.Interface([
  "function getUserStreams(address) view returns (uint256[])",
  "function checker(uint256) view returns (bool canExec, bytes execPayload)",
  "function executePayment(uint256)",
  "function nextDueTime(uint256) view returns (uint256)",
  "function getStream(uint256) view returns (tuple(uint256 id,address sender,address recipient,uint256 amountPerInterval,uint8 interval,uint256 startTime,uint256 lastExecuted,uint256 totalDeposited,uint256 totalPaid,bool active,string label))",
  "function streamBalance(uint256) view returns (uint256)"
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

async function checkAndExecute() {
  const now = Math.floor(Date.now() / 1000);
  const time = new Date().toLocaleTimeString();

  try {
    const streamsData = await call(iface.encodeFunctionData("getUserStreams", [wallet.address]));
    const ids = iface.decodeFunctionResult("getUserStreams", streamsData)[0];

    if (!ids.length) {
      console.log(`[${time}] No streams found.`);
      return;
    }

    let executed = 0, pending = 0, inactive = 0;

    for (const id of ids) {
      try {
        const checkerData = await call(iface.encodeFunctionData("checker", [id]));
        const [canExec] = iface.decodeFunctionResult("checker", checkerData);

        if (canExec) {
          console.log(`[${time}] Stream ${id}: executing payment...`);
          const txHash = await sendTx(iface.encodeFunctionData("executePayment", [id]));
          console.log(`[${time}] Stream ${id}: payment sent — ${txHash}`);
          executed++;
        } else {
          try {
            const dueData = await call(iface.encodeFunctionData("nextDueTime", [id]));
            const [due] = iface.decodeFunctionResult("nextDueTime", dueData);
            const mins = Math.ceil((Number(due) - now) / 60);
            if (mins > 0) {
              console.log(`[${time}] Stream ${id}: next payment in ${mins}min`);
              pending++;
            } else {
              console.log(`[${time}] Stream ${id}: inactive or empty`);
            }
          } catch(e) {}
        }
      } catch(e) {
        console.error(`[${time}] Stream ${id}: ${e.message}`);
      }
    }

    if (executed > 0) {
      console.log(`[${time}] Executed ${executed} payment(s).`);
    } else if (pending === 0) {
      console.log(`[${time}] All streams empty. Top up to resume.`);
    }

  } catch(e) {
    console.error(`[${time}] Check failed: ${e.message}`);
  }
}

async function loop() {
  console.log("FlowPay Keeper started — wallet:", wallet.address);
  if (ONCE) { await checkAndExecute(); process.exit(0); }
  while (true) {
    await checkAndExecute();
    await new Promise(r => setTimeout(r, CHECK_EVERY));
  }
}

loop().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
