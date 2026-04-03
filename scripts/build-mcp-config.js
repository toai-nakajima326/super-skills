#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DEFAULT_CATALOG_PATH = path.join(ROOT, "mcp", "catalog.json");
const DEFAULT_PROFILES_DIR = path.join(ROOT, "mcp", "profiles");
const VALID_FORMATS = new Set(["toml", "guidance", "json"]);
const VALID_RISK_LEVELS = new Set(["low", "medium", "high"]);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    catalogPath: DEFAULT_CATALOG_PATH,
    profilesDir: DEFAULT_PROFILES_DIR,
    profileIds: [],
    format: "toml",
    validateOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (!value) fail("--profile requires a value");
      options.profileIds.push(value);
      i += 1;
      continue;
    }
    if (arg === "--profiles") {
      const value = argv[i + 1];
      if (!value) fail("--profiles requires a value");
      options.profileIds.push(
        ...value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      i += 1;
      continue;
    }
    if (arg === "--format") {
      const value = argv[i + 1];
      if (!value) fail("--format requires a value");
      options.format = value;
      i += 1;
      continue;
    }
    if (arg === "--catalog") {
      const value = argv[i + 1];
      if (!value) fail("--catalog requires a value");
      options.catalogPath = path.resolve(ROOT, value);
      i += 1;
      continue;
    }
    if (arg === "--profiles-dir") {
      const value = argv[i + 1];
      if (!value) fail("--profiles-dir requires a value");
      options.profilesDir = path.resolve(ROOT, value);
      i += 1;
      continue;
    }
    if (arg === "--validate") {
      options.validateOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!VALID_FORMATS.has(options.format)) {
    fail(`unsupported format: ${options.format}`);
  }

  options.profileIds = Array.from(new Set(options.profileIds));
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/build-mcp-config.js [options]

Options:
  --profile <id>        Select a profile. Repeatable.
  --profiles a,b        Select multiple profiles in one flag.
  --format <type>       Output format: toml, guidance, json. Default: toml.
  --catalog <path>      Override the catalog path.
  --profiles-dir <dir>  Override the profiles directory.
  --validate            Validate catalog and profiles, then exit.
  --help                Show this help.
`);
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`failed to parse JSON at ${filePath}: ${error.message}`);
  }
}

function loadInputs(catalogPath, profilesDir) {
  if (!fs.existsSync(catalogPath)) fail(`missing catalog: ${catalogPath}`);
  if (!fs.existsSync(profilesDir)) fail(`missing profiles dir: ${profilesDir}`);

  const catalog = loadJson(catalogPath);
  const profilePaths = fs
    .readdirSync(profilesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => path.join(profilesDir, fileName));
  const profiles = profilePaths.map((filePath) => loadJson(filePath));

  return { catalog, profiles };
}

function validateCatalogAndProfiles(catalog, profiles) {
  if (!catalog || typeof catalog !== "object") {
    fail("catalog must be an object");
  }
  if (!Array.isArray(catalog.servers)) {
    fail("catalog.servers must be an array");
  }
  if (!catalog.default_profile || typeof catalog.default_profile !== "string") {
    fail("catalog.default_profile must be a string");
  }

  const serverIds = new Set();
  const serverMap = new Map();
  for (const server of catalog.servers) {
    const requiredKeys = [
      "id",
      "description",
      "transport",
      "risk_level",
      "requires_secrets",
      "default_enabled",
      "profiles",
      "notes",
    ];

    for (const key of requiredKeys) {
      if (!(key in server)) {
        fail(`catalog server is missing "${key}"`);
      }
    }
    if (!("command" in server) && !("url" in server)) {
      fail(`catalog server "${server.id}" must define command or url`);
    }
    if (!VALID_RISK_LEVELS.has(server.risk_level)) {
      fail(`catalog server "${server.id}" has invalid risk_level`);
    }
    if (!Array.isArray(server.profiles)) {
      fail(`catalog server "${server.id}" must define profiles as an array`);
    }
    if (!Array.isArray(server.args)) {
      fail(`catalog server "${server.id}" must define args as an array`);
    }
    if (!Array.isArray(server.env)) {
      fail(`catalog server "${server.id}" must define env as an array`);
    }
    if (serverIds.has(server.id)) {
      fail(`duplicate catalog server id: ${server.id}`);
    }
    serverIds.add(server.id);
    serverMap.set(server.id, server);
  }

  const profileIds = new Set();
  const profileMap = new Map();
  for (const profile of profiles) {
    if (!profile.id || typeof profile.id !== "string") {
      fail("each profile must define a string id");
    }
    if (profileIds.has(profile.id)) {
      fail(`duplicate profile id: ${profile.id}`);
    }
    if (!Array.isArray(profile.server_ids)) {
      fail(`profile "${profile.id}" must define server_ids as an array`);
    }
    profileIds.add(profile.id);
    profileMap.set(profile.id, profile);

    for (const serverId of profile.server_ids) {
      if (!serverMap.has(serverId)) {
        fail(`profile "${profile.id}" references unknown server "${serverId}"`);
      }
    }
  }

  if (!profileMap.has(catalog.default_profile)) {
    fail(`catalog.default_profile "${catalog.default_profile}" is not defined`);
  }

  for (const server of catalog.servers) {
    for (const profileId of server.profiles) {
      const profile = profileMap.get(profileId);
      if (!profile) {
        fail(`server "${server.id}" references unknown profile "${profileId}"`);
      }
      if (!profile.server_ids.includes(server.id)) {
        fail(
          `server "${server.id}" declares profile "${profileId}" but that profile does not include the server`,
        );
      }
    }
  }

  const core = profileMap.get("core");
  if (core) {
    for (const serverId of core.server_ids) {
      const server = serverMap.get(serverId);
      if (server.risk_level === "high") {
        fail(`core profile includes high-risk server "${serverId}"`);
      }
    }
  }

  return { serverMap, profileMap };
}

function selectProfiles(profileIds, catalog, profileMap) {
  const selected = profileIds.length > 0 ? profileIds : [catalog.default_profile];
  for (const profileId of selected) {
    if (!profileMap.has(profileId)) {
      fail(`unknown profile: ${profileId}`);
    }
  }
  return selected;
}

function selectServers(catalog, profileMap, selectedProfileIds) {
  const selectedServerIds = new Set();
  for (const profileId of selectedProfileIds) {
    const profile = profileMap.get(profileId);
    for (const serverId of profile.server_ids) {
      selectedServerIds.add(serverId);
    }
  }

  return catalog.servers.filter((server) => selectedServerIds.has(server.id));
}

function buildEnvInlineTable(envNames) {
  if (envNames.length === 0) return null;
  return `{ ${envNames
    .map((envName) => `${envName} = "\${${envName}}"`)
    .join(", ")} }`;
}

function renderToml(selectedProfiles, servers) {
  const lines = [];
  lines.push("# Generated by scripts/build-mcp-config.js");
  lines.push(`# Profiles: ${selectedProfiles.join(", ")}`);
  lines.push("# Safe-by-default note: only explicitly selected profiles are emitted.");
  lines.push("");

  for (const server of servers) {
    lines.push(`# ${server.description}`);
    lines.push(`# risk_level = ${server.risk_level}`);
    if (server.requires_secrets) {
      lines.push(`# requires_secrets = ${server.env.join(", ")}`);
    }
    if (server.notes) {
      lines.push(`# notes = ${server.notes}`);
    }
    lines.push(`[mcp_servers.${server.id}]`);
    lines.push(`transport = "${server.transport}"`);
    if ("command" in server) {
      lines.push(`command = "${escapeTomlString(server.command)}"`);
    }
    if ("url" in server) {
      lines.push(`url = "${escapeTomlString(server.url)}"`);
    }
    lines.push(`args = ${renderTomlArray(server.args)}`);
    const envInlineTable = buildEnvInlineTable(server.env);
    if (envInlineTable) {
      lines.push(`env = ${envInlineTable}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderGuidance(selectedProfiles, servers) {
  const lines = [];
  lines.push("MCP install guidance");
  lines.push(`Selected profiles: ${selectedProfiles.join(", ")}`);
  lines.push("");

  for (const server of servers) {
    lines.push(`- ${server.id}`);
    lines.push(`  Description: ${server.description}`);
    lines.push(`  Risk: ${server.risk_level}`);
    lines.push(`  Transport: ${server.transport}`);
    lines.push(
      `  Requires secrets: ${server.requires_secrets ? server.env.join(", ") : "none"}`,
    );
    lines.push(`  Default enabled: ${server.default_enabled ? "yes" : "no"}`);
    lines.push(`  Notes: ${server.notes}`);
  }

  const requiredEnv = Array.from(
    new Set(servers.flatMap((server) => (server.requires_secrets ? server.env : []))),
  );
  lines.push("");
  lines.push(
    `Required environment variables: ${requiredEnv.length > 0 ? requiredEnv.join(", ") : "none"}`,
  );
  lines.push("Unsafe-local or high-risk capabilities remain excluded unless their profile is selected explicitly.");
  return `${lines.join("\n")}\n`;
}

function renderJson(selectedProfiles, servers) {
  return JSON.stringify(
    {
      selected_profiles: selectedProfiles,
      server_ids: servers.map((server) => server.id),
      servers,
    },
    null,
    2,
  );
}

function renderTomlArray(values) {
  return `[${values.map((value) => `"${escapeTomlString(String(value))}"`).join(", ")}]`;
}

function escapeTomlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { catalog, profiles } = loadInputs(options.catalogPath, options.profilesDir);
  const { profileMap } = validateCatalogAndProfiles(catalog, profiles);

  if (options.validateOnly) {
    console.log(
      `Validated ${catalog.servers.length} catalog entries and ${profiles.length} profiles.`,
    );
    return;
  }

  const selectedProfiles = selectProfiles(options.profileIds, catalog, profileMap);
  const servers = selectServers(catalog, profileMap, selectedProfiles);

  let output;
  if (options.format === "toml") {
    output = renderToml(selectedProfiles, servers);
  } else if (options.format === "guidance") {
    output = renderGuidance(selectedProfiles, servers);
  } else {
    output = renderJson(selectedProfiles, servers);
  }

  process.stdout.write(output);
}

main();
