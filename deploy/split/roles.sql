-- Disposable rehearsal roles only; the database has no published port or persistent volume.
CREATE ROLE accounts_runtime LOGIN PASSWORD 'split-accounts-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE hearts_runtime LOGIN PASSWORD 'split-hearts-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE euchre_runtime LOGIN PASSWORD 'split-euchre-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO accounts_runtime, hearts_runtime, euchre_runtime;
