import { spawn } from 'node:child_process'
const p = spawn(process.execPath, ['packages/mcp/server.js'], { cwd: process.argv[2], stdio: ['pipe','pipe','pipe'] })
let buf = ''
const send = (o) => { const s = JSON.stringify(o) + '\n'; console.log('>>', s.trim().slice(0,200)); p.stdin.write(s) }
p.stdout.on('data', d => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx+1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { console.log('NON-JSON:', line.slice(0,200)); continue }
    console.log('<<', JSON.stringify(msg).slice(0, 500))
    if (msg.id === 1) { send({ jsonrpc:'2.0', method:'notifications/initialized' }); send({ jsonrpc:'2.0', id:2, method:'tools/list', params:{} }) }
    if (msg.id === 2) { send({ jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'screenpower_status', arguments:{} } }) }
    if (msg.id === 3) { p.stdin.end(); setTimeout(()=>{p.kill(); process.exit(0)}, 300) }
  }
})
p.stderr.on('data', d => console.log('ERR:', d.toString().slice(0,500)))
send({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'test',version:'1'} } })
setTimeout(()=>{ console.log('TIMEOUT'); p.kill(); process.exit(1) }, 20000)
