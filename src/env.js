// SpoolRSS was called Feedster. Installs set up under the old name keep working: each
// FEEDSTER_* setting counts as the SPOOLRSS_* one of the same name, unless that is also set.
// Imported first by the modules that read settings.

for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('FEEDSTER_')) continue;
  const name = `SPOOLRSS_${key.slice('FEEDSTER_'.length)}`;
  if (process.env[name] === undefined) process.env[name] = value;
}
