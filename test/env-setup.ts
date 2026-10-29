// Tests must never touch the real Discord API. dotenv does not overwrite an
// environment variable that is already set, so forcing the stub here wins over
// a developer's real token in .env — otherwise every login-path test would
// connect for real and hang on the gateway. The value is asserted against
// nowhere; it only has to be non-empty and obviously not a credential.
process.env.DISCORD_TOKEN = "test-token-login-is-stubbed";
