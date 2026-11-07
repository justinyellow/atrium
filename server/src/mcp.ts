import type { FastifyInstance, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { userFromBearer, type AuthUser } from './auth.js';
import { config } from './config.js';
import { ToolError, type ToolCtx } from './tools/context.js';
import { tools } from './tools/index.js';

/** Public base URL: PUBLIC_URL if set, otherwise derived from (trusted) forwarded headers. */
export function baseUrl(req: FastifyRequest) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

const INSTRUCTIONS =
  'Atrium is a self-hosted Notion-style workspace. Pages contain Markdown-like blocks; databases contain rows (pages with properties). ' +
  'Use search to find things, fetch to read a page or a database schema, query-database to list rows, create-pages / update-page to write. ' +
  'Property values are addressed by property NAME with friendly values (option names, emails, ISO dates). ' +
  'All actions run with the permissions of the connected user.';

function buildServer(ctx: ToolCtx) {
  const server = new McpServer({ name: 'atrium', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
      },
      async (args: any) => {
        try {
          const result = await t.run(ctx, args ?? {});
          return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          if (!(e instanceof ToolError)) console.error(JSON.stringify({ level: 'error', msg: 'mcp tool failed', tool: t.name, err: e?.message }));
          return { isError: true, content: [{ type: 'text' as const, text: e instanceof ToolError ? e.message : `Error: ${e?.message ?? 'unknown error'}` }] };
        }
      },
    );
  }
  return server;
}

async function bearerUser(req: FastifyRequest): Promise<AuthUser | undefined> {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? userFromBearer(h.slice(7).trim()) : undefined;
}

/**
 * Remote MCP endpoint (Streamable HTTP, stateless): every request builds a fresh server + transport,
 * so any instance (e.g. any ECS task behind an ALB) can serve any request — no sticky sessions.
 */
export default async function mcpRoutes(app: FastifyInstance) {


  app.post('/mcp', async (req, reply) => {
    const user = await bearerUser(req);
    const base = baseUrl(req);
    if (!user) {
      return reply
        .status(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
        .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required' }, id: null });
    }
    const server = buildServer({ user, baseUrl: base });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', msg: 'mcp request failed', err: e?.message }));
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  const notAllowed = async (_req: FastifyRequest, reply: any) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
