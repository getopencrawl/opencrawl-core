import pg from 'pg';

// Temporal keeps its existing physical cluster. Application state gets its own
// database and non-superuser login; normal app connections cannot alter Temporal.
const client = new pg.Client({host:'temporal-db', user:'temporal', database:'postgres', password:process.env.OPENCRAWL_TEMPORAL_PASSWORD});
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('opencrawl-database-provision'))");
  const password=process.env.OPENCRAWL_DATABASE_PASSWORD;
  if(!password)throw new Error('Application database password is missing');
  if(!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='opencrawl'")).rowCount) {
    const {rows}=await client.query("SELECT format('CREATE ROLE opencrawl LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text) AS sql",[password]);
    await client.query(rows[0].sql);
  }
  if(!(await client.query("SELECT 1 FROM pg_database WHERE datname='opencrawl'")).rowCount)
    await client.query('CREATE DATABASE opencrawl OWNER opencrawl');
  // Never silently rotate an existing installation's password.
  const app=new pg.Client({host:'temporal-db',user:'opencrawl',database:'opencrawl',password});
  try {await app.connect();await app.query('SELECT 1');} finally {await app.end();}
  console.log(JSON.stringify({database:'opencrawl',ready:true}));
} finally {await client.end();}
