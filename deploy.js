const { ethers } = require("ethers");
const solc       = require("solc");
const fs         = require("fs");
const path       = require("path");

const RPC_URL     = "https://arc-testnet.drpc.org";
const CHAIN_ID    = 5042002;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) { console.error("ERROR: Set PRIVATE_KEY env var"); process.exit(1); }

function compile(contractPath) {
  console.log("Compiling FlowPay.sol...");
  const source = fs.readFileSync(contractPath, "utf8");
  const input = {
    language: "Solidity",
    sources: { "FlowPay.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter(e => e.severity === "error");
    if (fatal.length) { fatal.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
  }
  const contract = output.contracts["FlowPay.sol"]["FlowPay"];
  return { abi: contract.abi, bytecode: "0x" + contract.evm.bytecode.object };
}

async function deploy() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "arc-testnet" });
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log("Balance :", ethers.formatEther(balance), "ETH");
  if (balance === 0n) { console.error("ERROR: No ETH. Fund your wallet first."); process.exit(1); }
  const { abi, bytecode } = compile(path.join(__dirname, "FlowPay.sol"));
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log("Deploying...");
  const contract = await factory.deploy();
  console.log("Tx hash :", contract.deploymentTransaction().hash);
  console.log("Waiting for confirmation...");
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("─────────────────────────────────────");
  console.log("FlowPay deployed at:", address);
  console.log("─────────────────────────────────────");
  fs.writeFileSync("flowpay-deployment.json", JSON.stringify({ address, chainId: CHAIN_ID, abi, deployedAt: new Date().toISOString() }, null, 2));
  console.log("Saved to flowpay-deployment.json");
}

deploy().catch(err => { console.error("Deploy failed:", err); process.exit(1); });
