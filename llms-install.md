# Install TheRundown Data MCP

There are two ways to connect. Use the hosted server unless you need a local process.

## Hosted server

- URL: `https://mcp.therundown.io/mcp`
- Transport: Streamable HTTP
- Authentication: send your TheRundown API key in the `X-TheRundown-Key` header, or as `Authorization: Bearer <key>`. Send one of the two, not both.
- Initialization and tool listings need no key. Every data tool call needs a key.
- Get a free API key at https://therundown.io/api. No credit card is needed.

Add a remote MCP server in your client with that URL and that header. Do not put the key in the URL, in a prompt or in a committed file.

The hosted server reports version 0.4.0 with 85 read-only tools. [COVERAGE.md](COVERAGE.md) lists them.

## Local server over stdio

The downloadable 0.2.3 release has six tools. [README.md](README.md) gives the download, its checksum and the client configuration for Claude Desktop and Cursor. It needs Node.js 22 or later and reads the key from the `THERUNDOWN_API_KEY` environment variable.

There is no published npm package.
