import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HeadbotManager } from '../lib/manager.js'

export const quiet = { warn() {}, error() {} }

export async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}

export async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = path.join(root, 'fake-dsh.mjs')
  const pluginLog = path.join(root, 'plugin-commands.log')
  await writeFile(fake, `import http from 'node:http';import {readFileSync,realpathSync,existsSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='plugin'){appendFileSync(${JSON.stringify(pluginLog)},args.join(' ')+'\\n');process.exit(0)}
const value=key=>args[args.indexOf(key)+1];
if(!readFileSync(value('--patch'),'utf8').includes('team-plugin.js'))process.exit(2);
if(!process.env.HEADBOT_TEAM_TOKEN||process.cwd()!==realpathSync(process.env.HEADBOT_TEAM_FILES_ROOT))process.exit(3);
const readyAt=Date.now()+(existsSync(${JSON.stringify(path.join(root, 'transient-404'))})?800:0);
http.createServer((_req,res)=>{res.statusCode=Date.now()<readyAt?404:200;res.end('ok')}).listen(Number(value('--port')),'127.0.0.1');
console.log('dsh web: '+value('--public-url')+'?token=test-secret');`)
  const manager = new HeadbotManager({ dataDir: path.join(root, 'headbot'), dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() }, { parentPort: await port(), logger: quiet })
  t.after(() => manager.close())
  return { root, manager, fake, pluginLog }
}

export async function add(manager, id) {
  return manager.createTeam({ id, name: id.toUpperCase(), port: await port(), autoStart: false })
}
