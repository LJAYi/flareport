import { readFile, writeFile } from "node:fs/promises";

export function configureExistingResources(config, databaseId, bucketName) {
  if (!databaseId && !bucketName) return config;
  if (!databaseId || !bucketName) throw new Error("OPEN_CONNECT_D1_DATABASE_ID and OPEN_CONNECT_R2_BUCKET_NAME must be set together");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error("OPEN_CONNECT_D1_DATABASE_ID must be a D1 database UUID");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(bucketName)) {
    throw new Error("OPEN_CONNECT_R2_BUCKET_NAME must be a valid R2 bucket name");
  }
  const result = structuredClone(config);
  const databases = result.d1_databases?.filter(item => item.binding === "DB") ?? [];
  const buckets = result.r2_buckets?.filter(item => item.binding === "TRANSIT_FILES") ?? [];
  if (databases.length !== 1 || buckets.length !== 1) throw new Error("Expected exactly one DB and TRANSIT_FILES binding");
  databases[0].database_id = databaseId;
  buckets[0].bucket_name = bucketName;
  return result;
}

if (import.meta.main) {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const config = JSON.parse(await readFile(path, "utf8"));
  const result = configureExistingResources(config, process.env.OPEN_CONNECT_D1_DATABASE_ID, process.env.OPEN_CONNECT_R2_BUCKET_NAME);
  if (result !== config) await writeFile(path, JSON.stringify(result, null, 2) + "\n");
  console.log(result === config ? "Using Deploy Button resource provisioning" : "Configured existing resources for this build");
}
