// Integration tests write to a real PostgreSQL database. Refuse anything that is not clearly a
// throwaway test database so they can never touch business data.
const url = process.env.DATABASE_URL ?? "";
const name = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : "";
if (!name.endsWith("_test")) {
  throw new Error(
    `Integration tests need TEST_DATABASE_URL pointing at a database whose name ends in "_test" (got "${name || "nothing"}"). ` +
      `Create one with: createdb vyapargst_test && DATABASE_URL=<that url> npx prisma migrate deploy`
  );
}
