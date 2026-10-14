// Non-interactive first-run setup inside the container (creator-side tool).
// Usage: node deploy/container/headless-setup.mjs /setup/params.json
// params: { name, creatorAddress, genesisFile, upstreamRepoUrl? }
import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "../../dist/identity/wallet.js";
import { provision } from "../../dist/identity/provision.js";
import { createConfig, saveConfig } from "../../dist/config.js";
import { writeDefaultHeartbeatConfig } from "../../dist/heartbeat/config.js";
import { generateSoulMd, installDefaultSkills } from "../../dist/setup/defaults.js";
import { DEFAULT_TREASURY_POLICY } from "../../dist/types.js";

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const genesisPrompt = fs.readFileSync(params.genesisFile, "utf-8").trim();
const dir = getAutomatonDir();

const { chainIdentity, isNew } = await getWallet("evm");
const walletAddress = chainIdentity.address;
console.log(`wallet ${isNew ? "created" : "loaded"}: ${walletAddress}`);

let apiKey = "";
try {
  apiKey = (await provision()).apiKey;
  console.log("conway api key provisioned");
} catch (err) {
  console.log(`conway api key NOT provisioned: ${err.message}`);
}

const config = createConfig({
  name: params.name,
  genesisPrompt,
  creatorAddress: params.creatorAddress,
  registeredWithConway: !!apiKey,
  sandboxId: "",
  walletAddress,
  apiKey,
  treasuryPolicy: { ...DEFAULT_TREASURY_POLICY },
  chainType: "evm",
});
// The container is the sandbox; bwrap does not nest under rootless podman.
config.localExecMode = "unsafe-host";
if (params.upstreamRepoUrl) config.upstreamRepoUrl = params.upstreamRepoUrl;
saveConfig(config);
writeDefaultHeartbeatConfig();

const constitutionDst = path.join(dir, "constitution.md");
if (fs.existsSync(constitutionDst)) fs.chmodSync(constitutionDst, 0o644);
fs.copyFileSync(path.join(process.cwd(), "constitution.md"), constitutionDst);
fs.chmodSync(constitutionDst, 0o444);
const soul = path.join(dir, "SOUL.md");
if (!fs.existsSync(soul)) fs.writeFileSync(soul, generateSoulMd(params.name, walletAddress, params.creatorAddress, genesisPrompt), { mode: 0o600 });
installDefaultSkills(config.skillsDir || "~/.automaton/skills");
fs.mkdirSync(path.join(dir, "workspace"), { recursive: true, mode: 0o700 });
console.log(`setup done. Fund ${walletAddress} with USDC on Base.`);
