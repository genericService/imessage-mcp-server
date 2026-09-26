// Pin a bearer token before the server module captures AUTH_TOKEN.
// A developer .env still wins when BEARER_TOKEN or AUTH_TOKEN is already set.
if (!process.env.BEARER_TOKEN && !process.env.AUTH_TOKEN) {
  process.env.BEARER_TOKEN = '1ba52a7166e61f6af6a35399a555f4e940af4653b223e1f1225b3ca64de6fb7e';
}
