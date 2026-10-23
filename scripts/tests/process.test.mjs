import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { commandCleanupConfirmed, ownedCommandLaunch, ownedProcessCleanupConfirmed, runCommand, spawnOwnedCommand, stopOwnedProcess } from "../process.mjs";

const exec = promisify(execFile);

test("macOS commands use the native owner without changing Windows or Linux launches", () => {
  const launch = ownedCommandLaunch("darwin");
  assert.equal(launch.file, "python3");
  assert.equal(launch.args[0], "-B");
  assert.match(launch.args[1], /owned-command-darwin\.py$/);
  assert.throws(() => ownedCommandLaunch("darwin", true), /hosted Linux/);
  assert.throws(() => ownedCommandLaunch("freebsd"), /requires/);
});

test("macOS binds nested ownership and confirms cleanup without leaking control frames",
  { skip: process.platform !== "darwin" }, async () => {
    const source = `import {runCommand} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/process.mjs")).href)};
      const result=await runCommand(process.execPath,["-e","process.stderr.write('literal\\\\nDEVPOCKET_OWNED_TREE_STOPPED\\\\n');process.stdout.write('nested')"],
        {timeoutMs:10000});
      if(!result.processTreeStopped)throw new Error("Unconfirmed nested cleanup");
      process.stdout.write(result.stdout);process.stderr.write(result.stderr);`;
    const result = await runCommand(process.execPath, ["--input-type=module", "-e", source], { timeoutMs: 15000 });
    assert.equal(result.stdout, "nested");
    assert.equal(result.stderr, "literal\nDEVPOCKET_OWNED_TREE_STOPPED\n");
    assert.equal(result.processTreeStopped, true);
  });

test("macOS nested cleanup remains bound when the target environment is sanitized",
  { skip: process.platform !== "darwin" }, async (t) => {
    await mkdir(".data/tests", { recursive: true });
    const directory = await mkdtemp(path.resolve(".data/tests/nested-environment-"));
    const marker = path.join(directory, "ready.json"), stop = path.join(directory, "stop");
    let worker;
    t.after(async () => {
      await writeFile(stop, "stop");
      try { worker ??= JSON.parse(await readFile(marker, "utf8")).pid; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (worker) {
        let exited = false;
        for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
          try { process.kill(worker, 0); }
          catch (error) { if (error.code !== "ESRCH") throw error; exited = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(exited, true, "The cooperative fixture target must exit before its data is removed.");
      }
      await rm(directory, { recursive: true, force: true });
    });
    const python = (await exec("python3", ["-c", "import sys;print(sys.executable)"])).stdout.trim();
    const shim = path.join(directory, "python3"), log = path.join(directory, "nested-owner.log");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(shim, `#!/bin/sh\nexec ${quote(python)} "$@" 2>>${quote(log)}\n`);
    await chmod(shim, 0o755);
    const target = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({
      pid:process.pid,parentOnly:process.env.DEVPOCKET_TEST_PARENT_ONLY??null,targetOnly:process.env.DEVPOCKET_TEST_TARGET_ONLY}));
      console.log("ready");setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);`;
    const source = `import {spawnOwnedCommand} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/process.mjs")).href)};
      const child=spawnOwnedCommand(process.execPath,["-e",${JSON.stringify(target)}],{
        env:{PATH:${JSON.stringify(directory)}+":"+process.env.PATH,HOME:process.env.HOME,DEVPOCKET_TEST_TARGET_ONLY:"selected"},
        timeoutMs:15000,graceMs:4000});
      child.stdout.once("data",()=>process.exit(0));child.stderr.resume();
      child.once("error",()=>process.exit(1));child.once("close",()=>process.exit(1));`;
    const result = await runCommand(process.execPath, ["--input-type=module", "-e", source],
      { timeoutMs: 15000, env: { ...process.env, DEVPOCKET_TEST_PARENT_ONLY: "not-for-the-target" } });
    const ready = JSON.parse(await readFile(marker, "utf8"));
    worker = ready.pid;
    assert.equal(ready.parentOnly, null);
    assert.equal(ready.targetOnly, "selected");
    assert.equal(result.processTreeStopped, true);
    assert.throws(() => process.kill(worker, 0), { code: "ESRCH" },
      "The outer receipt must wait for the sanitized nested command's actual cleanup.");
  });

test("macOS refuses expired and pre-cancelled startup before creating its target",
  { skip: process.platform !== "darwin" }, async (t) => {
    await mkdir(".data/tests", { recursive: true });
    const root = await mkdtemp(path.resolve(".data/tests/darwin-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const cancelled of [false, true]) {
      const marker = path.join(root, String(cancelled));
      const child = spawnOwnedCommand(process.execPath,
        ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"unexpected")`],
        { timeoutMs: 5000, graceMs: 100, cancelled, deadlineUnixMs: cancelled ? Date.now() + 5000 : Date.now() - 1 });
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
      const [code] = await once(child, "close");
      assert.equal(code, cancelled ? 130 : 124);
      assert.equal(ownedProcessCleanupConfirmed(child), true);
      await assert.rejects(access(marker), { code: "ENOENT" });
    }
  });

test("cleanup recovery accepts only the original observed outcome and exact command",
  { skip: process.platform !== "darwin" }, async () => {
    const command = { file: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd() };
    const result = await runCommand(command.file, command.args, { cwd: command.cwd });
    assert.equal(commandCleanupConfirmed(result, command), true);
    assert.equal(commandCleanupConfirmed({ ...result }, command), false);
    assert.equal(commandCleanupConfirmed(result, { ...command, args: ["-e", "process.exit(37)"] }), false);
    assert.equal(commandCleanupConfirmed(result, { ...command, cwd: path.dirname(command.cwd) }), false);
    assert.equal(commandCleanupConfirmed(undefined, command), false);
  });

test("macOS cleanup never treats an unstable process snapshot as an empty tree",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
class Fixture:
 def __init__(self,values,unstable=False):
  self.values=iter(values);self.current=(1,1);self.unstable=unstable;self.alive=True;self.sent=[]
 def processes(self): return [os.getpid()+1] if self.alive else []
 def responsible(self,pid): return os.getpid()
 def identity(self,pid):
  self.current=(1,self.current[1]+1) if self.unstable else next(self.values,self.current)
  return S(bsd=S(pid=pid,status=2),identity=S(unique=self.current[0],version=self.current[1]))
 def owned(self): return module["Darwin"].owned(self)
 def send(self,info,number):
  self.sent.append([info.identity.unique,info.identity.version]);self.alive=False
results={}
for name,values,unstable in [
 ("exec",[(1,1),(1,2)],False),("recycled",[(1,1),(2,1)],False),("unstable",[],True)]:
 clock=iter(range(1000));module["time"].monotonic=lambda:next(clock)
 native=Fixture(values,unstable)
 scope=module["Scope"].__new__(module["Scope"]);scope.native=native;scope.nested={};scope.poll=lambda:None
 try:
  scope.cleanup(S(poll=lambda:None));completed=True
 except RuntimeError:
  completed=False
 results[name]={"completed":completed,"signals":native.sent}
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), {
      exec: { completed: true, signals: [[1, 2]] },
      recycled: { completed: true, signals: [[2, 1]] },
      unstable: { completed: false, signals: [] },
    });
  });

test("macOS identity reads retry transient kernel refusal without accepting permanent denial",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import ctypes,errno,json,os,runpy,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
results={}
for mode in ["ready","gone","denied"]:
 calls=[0]
 def query(pid,flavor,argument,pointer,size):
  calls[0]+=1
  if calls[0]==1 or mode=="denied":
   ctypes.set_errno(errno.EPERM);return 0
  if mode=="gone":
   ctypes.set_errno(errno.ESRCH);return 0
  value=ctypes.cast(pointer,ctypes.POINTER(module["ProcessInfo"])).contents
  value.bsd.pid=pid;value.bsd.status=2;value.identity.unique=17;value.identity.version=3
  return size
 native=module["Darwin"].__new__(module["Darwin"]);native.lib=S(proc_pidinfo=query)
 try:
  info=native.identity(os.getpid()+1)
  result="gone" if info is None else [info.identity.unique,info.identity.version]
 except RuntimeError:result="denied"
 results[mode]={"result":result,"retried":calls[0]>1,"bounded":calls[0]<=8}
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), {
      ready: { result: [17, 3], retried: true, bounded: true },
      gone: { result: "gone", retried: true, bounded: true },
      denied: { result: "denied", retried: true, bounded: true },
    });
  });

test("macOS cleanup follows fork-and-exit races until an empty observation is stable",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
class Fixture:
 def __init__(self,mode):
  self.mode=mode;self.scans=0;self.reads=0;self.alive=True;self.sent=[]
 def processes(self):
  self.scans+=1
  if not self.alive:return []
  if self.scans==1:return [] if self.mode=="late-child" else [os.getpid()+1]
  return [os.getpid()+2]
 def responsible(self,pid):return os.getpid()
 def identity(self,pid):
  self.reads+=1
  if pid==os.getpid()+1:
   if self.mode.startswith("before") or self.reads>1:
    if self.mode.endswith("missing"):return None
    return S(bsd=S(pid=pid,status=5),identity=S(unique=1,version=1))
  return S(bsd=S(pid=pid,status=2),identity=S(unique=pid,version=1))
 def owned(self):return module["Darwin"].owned(self)
 def send(self,info,number):self.sent.append(info.bsd.pid-os.getpid());self.alive=False
results={}
for mode in ["before-missing","before-zombie","between-missing","between-zombie","late-child"]:
 native=Fixture(mode)
 scope=module["Scope"].__new__(module["Scope"]);scope.native=native;scope.nested={};scope.poll=lambda:None
 scope.cleanup(S(poll=lambda:None))
 results[mode]={"alive":native.alive,"signals":native.sent}
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    const expected = { alive: false, signals: [2] };
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries([
      "before-missing", "before-zombie", "between-missing", "between-zombie", "late-child",
    ].map((name) => [name, expected])));
  });

test("macOS unconfirmed nested cleanup still stops verifiably owned sibling processes",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,socket,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
class Fixture:
 def __init__(self):self.alive=True;self.sent=[]
 def live(self,info):return False
 def owned(self):
  return [S(bsd=S(pid=os.getpid()+2,parent=os.getpid(),status=2),identity=S(unique=2,version=1))] if self.alive else []
 def send(self,info,number):self.sent.append(info.bsd.pid-os.getpid());self.alive=False
results={}
for mode in ["dead-supervisor","unacknowledged-eof","invalid-acknowledgement"]:
 native=Fixture();scope=module["Scope"](native)
 reader,writer=socket.socketpair()
 if mode=="invalid-acknowledgement":writer.sendall(b"invalid\\n")
 writer.close()
 if mode=="dead-supervisor":reader.close();reader=None
 scope.nested[os.getpid()+1]={"identity":S(bsd=S(pid=os.getpid()+1,parent=os.getpid()+3)),"channel":reader,"clean":False,"buffer":b""}
 try:
  try:scope.cleanup(S(poll=lambda:None));completed=True
  except (OSError,ValueError,RuntimeError):completed=False
  results[mode]={"completed":completed,"alive":native.alive,"signals":native.sent}
 finally:scope.close(False)
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries([
      "dead-supervisor", "unacknowledged-eof", "invalid-acknowledgement",
    ].map((name) => [name, { completed: false, alive: false, signals: [2] }])));
  });

test("macOS cleanup drains a dead peer's queued acknowledgement before retaining a failure",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,socket,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
class Fixture:
 def __init__(self,mode,writer):self.mode=mode;self.writer=writer;self.observations=0;self.alive=True;self.sent=[]
 def live(self,info):
  self.observations+=1
  if self.observations==1:
   if self.mode=="late-clean":self.writer.sendall(b"clean\\n");self.writer.close()
   elif self.mode=="late-fragmented":self.writer.sendall(b"cl")
   elif self.mode=="partial-eof":self.writer.sendall(b"cl");self.writer.close()
   elif self.mode=="late-malformed":self.writer.sendall(b"invalid\\n");self.writer.close()
   else:self.writer.close()
  elif self.mode=="late-fragmented" and self.observations==2:
   self.writer.sendall(b"ean\\n");self.writer.close()
  return False
 def owned(self):
  return [S(bsd=S(pid=os.getpid()+2))] if self.alive else []
 def send(self,info,number):self.sent.append(info.bsd.pid-os.getpid());self.alive=False
results={}
for mode in ["late-clean","late-fragmented","late-eof","partial-eof","late-malformed"]:
 clock=iter(range(1000));module["time"].monotonic=lambda:next(clock)
 reader,writer=socket.socketpair();native=Fixture(mode,writer);scope=module["Scope"](native)
 scope.nested[os.getpid()+1]={"identity":S(bsd=S(pid=os.getpid()+1,parent=os.getpid()+3)),"channel":reader,"clean":False,"buffer":b""}
 try:
  try:scope.cleanup(None);completed=True
  except RuntimeError:completed=False
  results[mode]={"completed":completed,"signals":native.sent}
 finally:writer.close();scope.close(False)
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries([
      "late-clean", "late-fragmented", "late-eof", "partial-eof", "late-malformed",
    ].map((name) => [name, { completed: ["late-clean", "late-fragmented"].includes(name), signals: [2] }])));
  });

test("macOS cleanup tolerates stable zombies but not continuously disappearing identities",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,sys
from types import SimpleNamespace as S
module=runpy.run_path(sys.argv[1],run_name="fixture")
class Fixture:
 def __init__(self,mode):self.mode=mode;self.scans=0;self.alive=True;self.sent=[]
 def processes(self):
  self.scans+=1
  if self.mode=="transient" and self.scans>1:return []
  return [os.getpid()+1]+([os.getpid()+2] if self.mode=="mixed" and self.alive else [])
 def identity(self,pid):
  if pid==os.getpid()+1 and self.mode!="zombie":return None
  return S(bsd=S(pid=pid,status=5 if self.mode=="zombie" else 2),identity=S(unique=pid,version=1))
 def responsible(self,pid):return os.getpid()
 def owned(self):return module["Darwin"].owned(self)
 def send(self,info,number):self.sent.append(info.bsd.pid-os.getpid());self.alive=False
results={}
for mode in ["zombie","transient","missing","mixed"]:
 clock=iter(range(1000));module["time"].monotonic=lambda:next(clock)
 native=Fixture(mode)
 scope=module["Scope"].__new__(module["Scope"]);scope.native=native;scope.nested={};scope.poll=lambda:None
 try:scope.cleanup(None);completed=True
 except RuntimeError:completed=False
 results[mode]={"completed":completed,"signals":native.sent,"rescanned":native.scans>1}
print(json.dumps(results))
`;
    const result = await exec("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), {
      zombie: { completed: true, signals: [], rescanned: true },
      transient: { completed: true, signals: [], rescanned: true },
      missing: { completed: false, signals: [], rescanned: true },
      mixed: { completed: false, signals: [2], rescanned: true },
    });
  });

test("macOS a failed nested scope drains real PID-bound target and sibling processes",
  { skip: process.platform !== "darwin" }, async () => {
    const script = `import json,os,runpy,select,signal,subprocess,sys
module=runpy.run_path(sys.argv[1],run_name="fixture")
native=module["Darwin"]();children=[];scope=None
worker="import time;print('ready',flush=True);time.sleep(15)"
launcher="import os,sys;os.execv(sys.executable,[sys.executable,'-c',"+repr(worker)+"])"
try:
 for _ in range(3):
  child=subprocess.Popen([sys.executable,"-c",launcher],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  children.append((child,None))
  if not select.select([child.stdout],[],[],5)[0] or child.stdout.readline()!=b"ready\\n":
   raise RuntimeError("Fixture child did not complete interpreter startup")
  info=native.identity(child.pid)
  if info is None or info.bsd.parent!=os.getpid():
   raise RuntimeError("Missing fixture child identity")
  children[-1]=(child,info)
 peer,peer_info=children[0];workers=children[1:]
 native.send(peer_info,signal.SIGKILL);peer.wait(timeout=5)
 # Keep the negative protocol state local; never corrupt the enclosing verifier's registered scope.
 def owned():
  result=[]
  for child,bound in workers:
   if child.poll() is not None:continue
   current=native.identity(child.pid)
   if current is None or current.bsd.status==5:continue
   if (current.identity.unique!=bound.identity.unique or current.identity.version!=bound.identity.version or
       current.bsd.parent!=os.getpid() or native.responsible(child.pid)!=native.responsible(os.getpid())):
    raise RuntimeError("Fixture child ownership changed")
   result.append(current)
  return result
 native.owned=owned
 scope=module["Scope"](native)
 scope.nested[peer.pid]={"identity":peer_info,"channel":None,"clean":False,"buffer":b""}
 try:scope.cleanup(workers[0][0]);completed=True
 except RuntimeError:completed=False
 result={"completed":completed,"stopped":[child.poll()==-signal.SIGKILL for child,_ in workers]}
finally:
 for child,info in children:
  if child.poll() is None:
   if info is None:child.kill()
   else:native.send(info,signal.SIGKILL)
  child.wait(timeout=5)
  child.stdout.close()
 if scope is not None:scope.close(False)
print(json.dumps(result))
`;
    const result = await runCommand("python3", ["-B", "-c", script, path.resolve("scripts/owned-command-darwin.py")],
      { timeoutMs: 10000 });
    assert.equal(result.processTreeStopped, true);
    assert.deepEqual(JSON.parse(result.stdout), { completed: false, stopped: [true, true] },
      "The cleanup error must remain visible after both real owned processes are stopped.");
  });

test("macOS confirms timed-out and cancelled native commands that close their standard input",
  { skip: process.platform !== "darwin" }, async (t) => {
    await mkdir(".data/tests", { recursive: true });
    const directory = await mkdtemp(path.resolve(".data/tests/closed-input-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const cancelled of [false, true]) await t.test(cancelled ? "cancelled" : "timed out", async (t) => {
      const marker = path.join(directory, String(cancelled)), controller = new AbortController();
      const args = ["-e", `const fs=require("node:fs");fs.closeSync(0);fs.writeFileSync(${JSON.stringify(marker)},"ready");setInterval(()=>{},1000)`];
      const running = runCommand(process.execPath, args,
        { timeoutMs: cancelled ? 10000 : 3000, graceMs: 50, signal: controller.signal })
        .then(() => { throw new Error("An interrupted command cannot pass."); }, (error) => error);
      t.after(async () => { controller.abort(); await running; });
      let ready = false;
      for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
        try { ready = (await readFile(marker, "utf8")) === "ready"; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(ready, true, "Exercise a running target with a closed input pipe, not startup cancellation.");
      if (cancelled) controller.abort();
      const failure = await running;
      assert.equal(failure.commandOutcome.reason, cancelled ? "cancelled" : "timeout");
      assert.equal(failure.processTreeStopped, true);
      assert.equal(commandCleanupConfirmed(failure, { file: process.execPath, args, cwd: process.cwd() }), true);
      assert.doesNotMatch(failure.stderr, /BrokenPipeError/);
    });
  });

test("macOS a closed caller diagnostic pipe cannot suppress cancellation delivery",
  { skip: process.platform !== "darwin" }, async (t) => {
    await mkdir(".data/tests", { recursive: true });
    const directory = await mkdtemp(path.resolve(".data/tests/closed-diagnostic-pipe-"));
    const marker = path.join(directory, "cancel-received");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = `const fs=require('node:fs');let input='';process.stdin.on('data',bytes=>{
      input+=bytes;if(input.includes('cancel\\n')){fs.writeFileSync(${JSON.stringify(marker)},'cancel');process.exit(0)}});
      console.log('ready');setInterval(()=>{},1000);`;
    const source = `import {once} from 'node:events';
      import {spawnOwnedCommand,ownedProcessCleanupConfirmed} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/process.mjs")).href)};
      const child=spawnOwnedCommand(process.execPath,['-e',${JSON.stringify(target)}],{timeoutMs:5000,graceMs:500});
      child.stdin.on('error',error=>{if(error.code!=='EPIPE')throw error});
      const exited=once(child,'close');
      child.stdout.once('data',()=>{child.stderr.once('close',()=>child.stdin.end('cancel\\n'));child.stderr.destroy()});
      const [code]=await exited;
      console.log(JSON.stringify({code,receipt:ownedProcessCleanupConfirmed(child)}));`;
    const outcome = await runCommand(process.execPath, ["--input-type=module", "-e", source], { timeoutMs: 10000 });
    assert.deepEqual(JSON.parse(outcome.stdout), { code: 130, receipt: false },
      "Lost diagnostic output cannot fabricate a receipt for its caller.");
    assert.equal(await readFile(marker, "utf8"), "cancel", "The target must receive cancellation before forced cleanup.");
    assert.equal(outcome.processTreeStopped, true, "The enclosing scope still needs its own authentic cleanup receipt.");
  });

test("macOS cleans a live command after its calling process is forcibly terminated",
  { skip: process.platform !== "darwin" }, async (t) => {
    const source = `import {spawnOwnedCommand} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/process.mjs")).href)};
      const child=spawnOwnedCommand(process.execPath,["-e","console.log(process.pid);setInterval(()=>{},1000)"],{timeoutMs:10000,graceMs:100});
      child.stdout.on("data",bytes=>console.log("ready:"+Number(String(bytes).trim())+":"+child.pid));
      child.stderr.resume();setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", worker, bootstrap;
    parent.stderr.resume();
    t.after(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill();
      for (const pid of [worker, bootstrap].filter(Number.isSafeInteger)) {
        try { process.kill(pid, "SIGTERM"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The owned macOS command did not start.")), 5000);
      parent.stdout.on("data", (bytes) => {
        output += bytes;
        const match = /ready:(\d+):(\d+)\n/.exec(output);
        if (match) { worker = Number(match[1]); bootstrap = Number(match[2]); clearTimeout(timer); resolve(); }
      });
    });
    parent.kill("SIGKILL");
    await once(parent, "close");
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      try { process.kill(worker, 0); }
      catch (error) { if (error.code === "ESRCH") return; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("The owned command survived its caller's termination.");
  });

async function ownerFixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/windows-owner-"));
  await mkdir(path.join(root, "scripts"));
  for (const file of ["owned-command.ps1", "owned-command.cs", "owned-command-windows.mjs"]) {
    await copyFile(path.resolve("scripts", file), path.join(root, "scripts", file));
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function rawOwner(t, root, { deadlineUnixMs = Date.now() + 15000, input = "", file = process.execPath,
  args = ["-e", "process.stdout.write('completed')"], onOutput, env = process.env,
  entry = path.join(root, "scripts", "owned-command-windows.mjs"), preparationOwner = false } = {}) {
  const child = spawn(preparationOwner ? "pwsh" : process.execPath,
    preparationOwner ? ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "owned-command.ps1")] : [entry],
    { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; onOutput?.(stderr, child); });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
  const done = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await done; }
  });
  child.stdin.write(JSON.stringify({
    file, arguments: args, timeoutMs: 15000, graceMs: 250, ownerPid: process.pid, deadlineUnixMs, receiptId: randomUUID(),
  }) + "\n" + input);
  const [code] = await done;
  return { code, stdout, stderr };
}

async function prepareOwner(t, root, options) {
  const result = await rawOwner(t, root, options);
  assert.equal(result.code, 0, result.stderr);
}

test("fragmented cancellation is accepted while the PowerShell preparation mutex remains held",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    await prepareOwner(t, root, { preparationOwner: true });
    const cache = path.join(root, ".tools", "command-owner-v1");
    const [key] = await readdir(cache);
    const mutexKey = createHash("sha256").update(path.join(cache, key).toLowerCase()).digest("hex");
    const holder = await heldProcess(t, "pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$mutex=[Threading.Mutex]::new($false,'Local\\DevPocketCommandOwner_${mutexKey}');` +
      "$null=$mutex.WaitOne();[Console]::Out.WriteLine('locked');[Console]::In.ReadLine()|Out-Null;$mutex.ReleaseMutex();$mutex.Dispose()"],
    "locked");
    const marker = path.join(root, "must-not-start");
    let waiting = false, secondFragment;
    const result = await rawOwner(t, root, {
      preparationOwner: true, deadlineUnixMs: Date.now() + 8000,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      onOutput(stderr, child) {
        if (!waiting && stderr.includes(":preparation-wait\u001f")) {
          waiting = true;
          child.stdin.write("can");
          secondFragment = setTimeout(() => child.stdin.write("cel\n"), 100);
        }
      },
    });
    clearTimeout(secondFragment);
    assert.equal(waiting, true, "The first fragment must arrive after the owner starts its real preparation wait.");
    assert.equal(result.code, 130, "Fragmented cancellation must be accepted before the unchanged startup deadline.");
    assert.match(result.stderr, /:cancel-accepted\u001f/);
    assert.match(result.stderr, /:tree-stopped\u001f/);
    assert.doesNotMatch(result.stderr, /:active\u001f/);
    await assert.rejects(access(marker), { code: "ENOENT" });
    holder.child.stdin.end("\n");
    assert.equal((await holder.done)[0], 0);
  });

test("a partial preparation control line survives the handoff to the native parser",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    await prepareOwner(t, root, { preparationOwner: true });
    const cache = path.join(root, ".tools", "command-owner-v1");
    const [key] = await readdir(cache);
    const mutexKey = createHash("sha256").update(path.join(cache, key).toLowerCase()).digest("hex");
    const holder = await heldProcess(t, "pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$mutex=[Threading.Mutex]::new($false,'Local\\DevPocketCommandOwner_${mutexKey}');` +
      "$null=$mutex.WaitOne();[Console]::Out.WriteLine('locked');[Console]::In.ReadLine()|Out-Null;$mutex.ReleaseMutex();$mutex.Dispose()"],
    "locked");
    let waiting = false, active = false, release;
    const result = await rawOwner(t, root, {
      preparationOwner: true,
      args: ["-e", "process.stdin.once('data',()=>process.exit(0))"],
      onOutput(stderr, child) {
        if (!waiting && stderr.includes(":preparation-wait\u001f")) {
          waiting = true;
          child.stdin.write("can");
          release = setTimeout(() => holder.child.stdin.end("\n"), 100);
        }
        if (!active && stderr.includes(":active\u001f")) {
          active = true;
          child.stdin.write("cel\n");
        }
      },
    });
    clearTimeout(release);
    assert.equal(waiting, true);
    assert.equal(active, true, "The incomplete line is not itself an accepted cancellation.");
    assert.equal(result.code, 130, result.stderr);
    assert.match(result.stderr, /:cancel-accepted\u001f/);
    assert.match(result.stderr, /:tree-stopped\u001f/);
    assert.equal((await holder.done)[0], 0);
  });

test("PowerShell preparation rejects oversized or unknown control input before target execution",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const [name, input, message] of [
      ["oversized", "x".repeat(65537), /Owned command input exceeded its bound/],
      ["unknown", "notcancel\n", /Unsupported owned-command control message/],
      ["eof", "can", /:cancel-accepted\u001f/],
    ]) {
      await t.test(name, async (t) => {
        const root = await ownerFixture(t), marker = path.join(root, "must-not-start");
        await prepareOwner(t, root, { preparationOwner: true });
        const cache = path.join(root, ".tools", "command-owner-v1");
        const [key] = await readdir(cache);
        const mutexKey = createHash("sha256").update(path.join(cache, key).toLowerCase()).digest("hex");
        const holder = await heldProcess(t, "pwsh", ["-NoProfile", "-NonInteractive", "-Command",
          `$mutex=[Threading.Mutex]::new($false,'Local\\DevPocketCommandOwner_${mutexKey}');` +
          "$null=$mutex.WaitOne();[Console]::Out.WriteLine('locked');[Console]::In.ReadLine()|Out-Null;$mutex.ReleaseMutex();$mutex.Dispose()"],
        "locked");
        let waiting = false;
        const result = await rawOwner(t, root, {
          preparationOwner: true, deadlineUnixMs: Date.now() + 8000,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
          onOutput(stderr, child) {
            if (!waiting && stderr.includes(":preparation-wait\u001f")) {
              waiting = true;
              if (name === "eof") child.stdin.end(input);
              else child.stdin.write(input);
            }
          },
        });
        assert.equal(waiting, true);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.stderr, /:active\u001f/);
        await assert.rejects(access(marker), { code: "ENOENT" });
        holder.child.stdin.end("\n");
        assert.equal((await holder.done)[0], 0);
      });
    }
  });

async function heldProcess(t, file, args, ready) {
  const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const done = once(child, "close");
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await done; }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The owned fixture did not become ready.")), 15000);
    child.once("error", reject);
    child.once("close", () => { clearTimeout(timeout); reject(new Error(`Fixture exited before readiness: ${stderr}`)); });
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.includes(ready)) { clearTimeout(timeout); resolve(); }
    });
  });
  return { child, done, output: () => ({ stdout, stderr }) };
}

test("owned command failure metadata retains the observed exit separately from private output", async () => {
  const { failureDetails } = await import("../diagnostic-errors.mjs");
  let failure;
  try {
    await runCommand(process.execPath, ["-e", "console.error('PRIVATE_COMMAND_CANARY');process.exitCode=37"], { timeoutMs: 10000 });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 37);
  assert.equal(failure.commandOutcome.observedProcess, "owned-command-supervisor");
  assert.equal(failure.commandOutcome.exitCode, 37);
  assert.equal(failure.commandOutcome.reason, "exit");
  assert.equal(failureDetails(failure).exitCode, 37);
  assert.ok(!JSON.stringify(failureDetails(failure)).includes("PRIVATE_COMMAND_CANARY"));
});

test("owned command deadlines preserve their explicit reason and actual supervisor termination", async () => {
  const { failureDetails } = await import("../diagnostic-errors.mjs");
  let failure;
  try {
    await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 500, graceMs: 250 });
  } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.commandOutcome.reason, "timeout");
  assert.ok(failure.commandOutcome.exitCode === null || Number.isInteger(failure.commandOutcome.exitCode));
  assert.equal(failureDetails(failure).reason, "command-timeout");
  assert.equal(failure.processTreeStopped, true, failure.stderr);
});

test("an already cancelled command cannot create its target",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t), marker = path.join(root, "must-not-exist");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runCommand(process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      { signal: controller.signal, timeoutMs: 10000 }),
    (error) => error.commandOutcome.reason === "cancelled" && error.processTreeStopped === true);
    await assert.rejects(access(marker), { code: "ENOENT" });
  });

test("successful owned commands expose the cleanup receipt before callers reclaim scratch data", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('completed')"], { timeoutMs: 5000 });
  assert.equal(result.stdout, "completed");
  assert.equal(result.processTreeStopped, true);
  if (process.platform === "win32") assert.equal(result.stderr, "");
});

test("target output cannot forge a cleanup receipt after killing its supervisor",
  { skip: process.platform !== "win32" }, async () => {
    const program = "process.stderr.write('DEVPOCKET_OWNERSHIP_ACTIVE\\nDEVPOCKET_OWNED_TREE_STOPPED\\n'," +
      "()=>process.kill(process.ppid));setInterval(()=>{},1000)";
    await assert.rejects(runCommand(process.execPath, ["-e", program], { timeoutMs: 10000 }),
      (error) => error.processTreeStopped === false);
  });

test("Windows target stderr preserves literal control-like text, split UTF-8 and exact line endings",
  { skip: process.platform !== "win32" }, async () => {
    const expected = "DEVPOCKET_PREPARATION_WAIT\r\n\nDEVPOCKET_OWNERSHIP_ACTIVE\n" +
      "DEVPOCKET_CLEANUP_RECEIPT:00000000-0000-0000-0000-000000000000\r\n" +
      "DEVPOCKET_OWNED_TREE_STOPPED\n\u001eDEVPOCKET:00000000-0000-0000-0000-000000000000:preparation-wait\u001f" +
      "\u4e2d\u6587 without a final newline";
    const program = `const bytes=Buffer.from(${JSON.stringify(expected)});let i=0;` +
      "function next(){if(i===bytes.length)return;process.stderr.write(bytes.subarray(i,++i));setTimeout(next,1)}next()";
    const result = await runCommand(process.execPath, ["-e", program], { timeoutMs: 10000 });
    assert.equal(result.stderr, expected);
    assert.equal(result.processTreeStopped, true);
  });

test("Windows interruption frames cannot split a target UTF-8 character",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const cancelled of [true, false]) {
      await t.test(cancelled ? "accepted cancellation" : "deadline", async (t) => {
        const root = await ownerFixture(t), marker = path.join(root, "first-byte-written");
        const controller = new AbortController();
        const program = `const fs=require('node:fs');` +
          `process.stderr.write(Buffer.from([0xe4]),()=>fs.writeFileSync(${JSON.stringify(marker)},'ready'));` +
          "process.stdin.once('data',()=>process.stderr.write(Buffer.from([0xb8,0xad]),()=>process.exit(0)));";
        const running = runCommand(process.execPath, ["-e", program],
          { timeoutMs: cancelled ? 10000 : 5000, graceMs: 1000, signal: controller.signal })
          .then(() => { throw new Error("An interrupted operation cannot pass."); }, (error) => error);
        t.after(async () => { controller.abort(); await running; });
        let ready = false;
        for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
          try { ready = (await readFile(marker, "utf8")) === "ready"; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(ready, true, "The target must have written its first UTF-8 byte before interruption.");
        if (cancelled) controller.abort();
        const failure = await running;
        assert.equal(failure.commandOutcome.reason, cancelled ? "cancelled" : "timeout");
        assert.equal(failure.processTreeStopped, true);
        assert.equal(failure.stderr, "\u4e2d");
      });
    }
  });

test("an exited launcher cannot strand a descendant or keep a bounded command unresolved", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/process-owner-"));
  const pidFile = path.join(directory, "child.pid");
  let pid;
  t.after(async () => {
    try { pid ??= Number(await readFile(pidFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (pid) await exec("pwsh", ["-NoProfile", "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${pid} -Force }`]);
    await rm(directory, { recursive: true, force: true });
  });
  const program = [
    "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`,
  ].join("\n");
  let timer;
  const outcome = await Promise.race([
    runCommand(process.execPath, ["-e", program], { timeoutMs: 3000 }).then((result) => result, (error) => error),
    new Promise((resolve) => { timer = setTimeout(() => resolve("stranded"), 12_000); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(outcome, "stranded");
  assert.equal(outcome.processTreeStopped, true, outcome.stderr);
  pid = Number(await readFile(pidFile, "utf8"));
  const alive = await exec("pwsh", ["-NoProfile", "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output alive }`]);
  assert.equal(alive.stdout.trim(), "", "The owned descendant must actually be gone.");
});

test("an expired startup deadline cannot create a target even before the caller's timer is serviced",
  { skip: process.platform !== "win32" }, async (t) => {
    await mkdir(".data/tests", { recursive: true });
    const directory = await mkdtemp(path.resolve(".data/tests/process-deadline-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, "must-not-exist");
    const launch = ownedCommandLaunch();
    const child = spawn(launch.file, launch.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
    const done = once(child, "close");
    child.stdin.write(JSON.stringify({
      file: process.execPath, arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      timeoutMs: 5000, graceMs: 250, ownerPid: process.pid, deadlineUnixMs: Date.now() - 1, receiptId: randomUUID(),
    }) + "\n");
    const [code] = await done;
    assert.notEqual(code, 0, "An expired request cannot be reported as successful.");
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /:active\u001f/);
    assert.match(stderr, /:tree-stopped\u001f/);
  });

test("queued startup cancellation is accepted without preparing or starting the target",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t), marker = path.join(root, "must-not-exist");
    const result = await rawOwner(t, root, { input: "cancel\n",
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] });
    assert.equal(result.code, 130);
    assert.match(result.stderr, /:cancel-accepted\u001f/);
    assert.match(result.stderr, /:tree-stopped\u001f/);
    assert.doesNotMatch(result.stderr, /:active\u001f/);
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(access(path.join(root, ".tools")), { code: "ENOENT" });
  });

test("the Windows bootstrap rejects unsupported startup control lines before launching the target",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const prepared of [false, true]) {
      for (const followedByCancel of [false, true]) {
        await t.test(`${prepared ? "prepared" : "cold"}${followedByCancel ? " then cancel" : ""}`, async (t) => {
          const root = await ownerFixture(t), marker = path.join(root, "must-not-start");
          if (prepared) await prepareOwner(t, root);
          const result = await rawOwner(t, root, {
            input: "notcancel\n" + (followedByCancel ? "cancel\n" : ""),
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
          });
          assert.equal(result.code, 1, "Unsupported input must remain a failure, not success or accepted cancellation.");
          assert.match(result.stderr, /Unsupported owned-command control message/);
          assert.doesNotMatch(result.stderr, /notcancel|:active\u001f|:cancel-accepted\u001f/);
          assert.match(result.stderr, /:tree-stopped\u001f/);
          await assert.rejects(access(marker), { code: "ENOENT" });
        });
      }
    }
  });

test("unsupported fragmented bootstrap input stops a preparation wait without launching a target",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    await prepareOwner(t, root);
    const cache = path.join(root, ".tools", "command-owner-native-v1");
    const [key] = await readdir(cache);
    const mutexKey = createHash("sha256").update(path.join(cache, key).toLowerCase()).digest("hex");
    const holder = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(`\\\\.\\pipe\\DevPocketNativeOwner_${mutexKey}`, resolve);
    });
    t.after(() => new Promise((resolve) => holder.close(resolve)));
    const marker = path.join(root, "must-not-start");
    let waiting = false, secondFragment;
    t.after(() => clearTimeout(secondFragment));
    const result = await rawOwner(t, root, {
      deadlineUnixMs: Date.now() + 5000,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      onOutput(stderr, child) {
        if (!waiting && stderr.includes(":preparation-wait\u001f")) {
          waiting = true;
          child.stdin.write("notcan");
          secondFragment = setTimeout(() => child.stdin.end("cel\ncancel\n"), 100);
        }
      },
    });
    assert.equal(waiting, true, "Exercise the real asynchronous preparation wait.");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unsupported owned-command control message/);
    assert.match(result.stderr, /:tree-stopped\u001f/);
    assert.doesNotMatch(result.stderr, /notcancel|:active\u001f|:cancel-accepted\u001f|:deadline-expired\u001f/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  });

test("bootstrap input failure is not overwritten by an active child's graceful cancellation",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    let running = false;
    const result = await rawOwner(t, root, {
      args: ["-e", "process.stdin.once('data',()=>process.exit(0));process.stderr.write('target-started\\n');"],
      onOutput(stderr, child) {
        if (!running && stderr.includes("target-started\n")) {
          running = true;
          child.stdin.end("notcancel\ncancel\n");
        }
      },
    });
    assert.equal(running, true);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unsupported owned-command control message/);
    assert.match(result.stderr, /:tree-stopped\u001f/);
  });

async function publicationFixture(t, mode) {
  const root = await ownerFixture(t), cache = path.join(root, ".tools", "command-owner-native-v1");
  const marker = path.join(root, "target-started"), count = path.join(root, "publication-count");
  const entry = path.join(root, "scripts", "publication-failure.mjs");
  await writeFile(entry, [
    "import fs from 'node:fs/promises';import path from 'node:path';",
    "import {syncBuiltinESMExports} from 'node:module';",
    `const cache=${JSON.stringify(cache)}, count=${JSON.stringify(count)}, mode=${JSON.stringify(mode)};`,
    "const rename=fs.rename, remove=fs.rm, stat=fs.lstat;let attempts=0, deniedSource;",
    "fs.rename=async (from,to)=>{",
    "if(path.dirname(from)!==cache || !path.basename(from).startsWith('prepare-'))return rename(from,to);",
    "await fs.writeFile(count,String(++attempts));",
    "if(mode==='transient'&&attempts>1)return rename(from,to);",
    "if(mode==='collision'){await fs.mkdir(to);await fs.writeFile(path.join(to,'foreign'),'preserve');}",
    "if(mode==='cancel')process.stdin.emit('data','cancel\\n');",
    "if(mode==='deadline'){const now=Date.now;Date.now=()=>now()+60000;}",
    "deniedSource=from;throw Object.assign(new Error('INJECTED_PUBLICATION_FAILURE'),",
    "{code:mode==='eio'||mode==='cleanup'?'EIO':'EPERM'});};",
    "fs.lstat=async (file,options)=>{const info=await stat(file,options);",
    "return mode==='identity'&&file===deniedSource?new Proxy(info,{get(target,key){",
    "return key==='ino'?target.ino+(typeof target.ino==='bigint'?1n:1):Reflect.get(target,key);}}):info;};",
    "fs.rm=async (file,options)=>{",
    "if(mode==='cleanup'&&path.dirname(file)===deniedSource&&path.basename(file)==='owner.exe')",
    "throw Object.assign(new Error('INJECTED_SCRATCH_FAILURE'),{code:'EACCES'});return remove(file,options);};",
    "syncBuiltinESMExports();await import('./owned-command-windows.mjs');", "",
  ].join("\n"));
  if (mode === "missing-proof")
    await writeFile(path.join(root, "scripts", "owned-command.ps1"), "[Console]::In.ReadLine()|Out-Null\nexit 0\n");
  return { root, cache, marker, count, entry };
}

for (const mode of ["transient", "permanent", "eio", "collision", "identity", "cleanup", "missing-proof", "cancel", "deadline"])
  test(`Windows publication preserves failure, ownership and cleanup (${mode})`,
    { skip: process.platform !== "win32" }, async (t) => {
      const fixture = await publicationFixture(t, mode), { root, cache, marker, count, entry } = fixture;
      const result = await rawOwner(t, root, { entry,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] });
      assert.equal(result.code, mode === "transient" ? 0 : mode === "cancel" ? 130 : mode === "deadline" ? 124 : 1, result.stderr);
      if (["identity", "cleanup", "missing-proof"].includes(mode)) assert.doesNotMatch(result.stderr, /:tree-stopped\u001f/);
      else assert.match(result.stderr, /:tree-stopped\u001f/);
      if (mode === "transient") {
        assert.equal(await readFile(marker, "utf8"), "started");
        assert.ok(Number(await readFile(count, "utf8")) >= 2 && Number(await readFile(count, "utf8")) <= 4);
      } else {
        await assert.rejects(access(marker), { code: "ENOENT" });
        assert.doesNotMatch(result.stderr, /:active\u001f/);
        if (mode !== "missing-proof") assert.equal(Number(await readFile(count, "utf8")), mode === "permanent" ? 4 : 1);
      }
      if (mode === "missing-proof") assert.match(result.stderr, /preparation failed \(0\)/);
      if (mode === "cleanup") assert.match(result.stderr, /INJECTED_SCRATCH_FAILURE/);
      if (mode === "identity") assert.match(result.stderr, /staging directory changed/);
      if (mode === "eio" || mode === "permanent") assert.match(result.stderr, /INJECTED_PUBLICATION_FAILURE/);
      if (mode === "cancel") assert.match(result.stderr, /:cancel-accepted\u001f/);
      if (mode === "deadline") assert.match(result.stderr, /:deadline-expired\u001f/);
      const remaining = await readdir(cache);
      if (mode === "collision") {
        assert.equal(remaining.length, 1);
        assert.equal(await readFile(path.join(cache, remaining[0], "foreign"), "utf8"), "preserve");
      } else if (["identity", "cleanup"].includes(mode)) {
        assert.equal(remaining.length, 1);
        assert.ok(remaining[0].startsWith("prepare-"));
        await access(path.join(cache, remaining[0], "owner.exe"));
      } else if (mode !== "transient") assert.deepEqual(remaining, []);
    });

test("invalid bootstrap requests cannot emit a cleanup acknowledgement for unvalidated input",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t), result = await rawOwner(t, root, { file: 42 });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Invalid Windows owned-command request/);
    assert.doesNotMatch(result.stderr, /:tree-stopped\u001f|:active\u001f/);
    await assert.rejects(access(path.join(root, ".tools")), { code: "ENOENT" });
  });

test("the bootstrap input budget stays a failure without launching a target",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t), marker = path.join(root, "must-not-start");
    const result = await rawOwner(t, root, {
      input: "x".repeat(1048577),
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Owned-command input exceeded its bound/);
    assert.doesNotMatch(result.stderr, /:active\u001f|:cancel-accepted\u001f/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  });

test("cold ownership preparation is atomic across concurrent callers and invalidates changed source",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    const results = await Promise.all(Array.from({ length: 4 }, () => rawOwner(t, root)));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "completed");
      assert.match(result.stderr, /:tree-stopped\u001f/);
    }
    const cache = path.join(root, ".tools", "command-owner-native-v1");
    const first = await readdir(cache);
    assert.equal(first.length, 1, "Only a complete source-bound artifact may be published.");
    const source = path.join(root, "scripts", "owned-command.cs");
    await writeFile(source, (await readFile(source, "utf8")) + "\n");
    const changed = await rawOwner(t, root);
    assert.equal(changed.code, 0, changed.stderr);
    const next = await readdir(cache);
    assert.equal(next.length, 2);
    const manifests = await Promise.all(next.map(async (entry) =>
      JSON.parse(await readFile(path.join(cache, entry, "manifest.json"), "utf8"))));
    assert.notEqual(manifests[0].source, manifests[1].source);
    assert.equal(manifests[0].toolchain, manifests[1].toolchain);
  });

test("deadline and accepted cancellation while awaiting preparation never launch the target",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    await prepareOwner(t, root);
    const cache = path.join(root, ".tools", "command-owner-native-v1");
    const [key] = await readdir(cache);
    const mutexKey = createHash("sha256").update(path.join(cache, key).toLowerCase()).digest("hex");
    const holder = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(`\\\\.\\pipe\\DevPocketNativeOwner_${mutexKey}`, resolve);
    });
    t.after(() => new Promise((resolve) => holder.close(resolve)));
    for (const cancelled of [false, true]) {
      const marker = path.join(root, cancelled ? "cancelled-target" : "expired-target");
      let waiting = false;
      const result = await rawOwner(t, root, {
        deadlineUnixMs: Date.now() + 5000,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        onOutput(stderr, child) {
          if (!waiting && stderr.includes(":preparation-wait\u001f")) {
            waiting = true;
            if (cancelled) child.stdin.write("cancel\n");
          }
        },
      });
      assert.equal(waiting, true, "Exercise a real preparation wait, not only an already-expired request.");
      assert.equal(result.code, cancelled ? 130 : 124, result.stderr);
      assert.match(result.stderr, cancelled ? /:cancel-accepted\u001f/ : /:deadline-expired\u001f/);
      assert.doesNotMatch(result.stderr, /:active\u001f/);
      await assert.rejects(access(marker), { code: "ENOENT" });
    }
  });

test("active Windows cancellation confirms native descendant exit before releasing its cleanup receipt",
  { skip: process.platform !== "win32" }, async (t) => {
    const program = "const {spawn}=require('node:child_process');" +
      "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'});" +
      "console.log('descendant:'+child.pid);setInterval(()=>{},1000)";
    const child = spawnOwnedCommand(process.execPath, ["-e", program], { timeoutMs: 20000, graceMs: 250 });
    const done = once(child, "close");
    let stdout = "", stderr = "";
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child); });
    const pid = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Owned descendant did not start.")), 15000);
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
        const match = /descendant:(\d+)/.exec(stdout);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
      child.once("close", () => { clearTimeout(timeout); reject(new Error(`Owner exited early: ${stderr}`)); });
    });
    const witness = await heldProcess(t, "pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$process=[Diagnostics.Process]::GetProcessById(${pid});$null=$process.Handle;` +
      "if($process.HasExited){throw 'Fixture already exited'};[Console]::Out.WriteLine('held');" +
      "if(-not $process.WaitForExit(10000)){throw 'Native handle did not signal exit'};[Console]::Out.WriteLine('exited');$process.Dispose()"],
    "held");
    child.stdin.write("cancel\n");
    assert.equal((await done)[0], 130);
    assert.match(stderr, /:cancel-accepted\u001f/);
    assert.equal(ownedProcessCleanupConfirmed(child), true);
    assert.equal((await witness.done)[0], 0);
    assert.match(witness.output().stdout, /exited/);
  });

test("invalid source, incomplete artifacts and mismatched toolchain evidence fail closed without fallback",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const fault of ["source", "missing-assembly", "assembly", "toolchain"]) {
      await t.test(fault, async (t) => {
        const root = await ownerFixture(t), marker = path.join(root, "must-not-exist");
        if (fault === "source") {
          await writeFile(path.join(root, "scripts", "owned-command.cs"), "#error rejected ownership fixture\n");
        } else {
          await prepareOwner(t, root);
          const cache = path.join(root, ".tools", "command-owner-native-v1");
          const [key] = await readdir(cache);
          if (fault === "missing-assembly") await rm(path.join(cache, key, "owner.exe"));
          if (fault === "assembly") await writeFile(path.join(cache, key, "owner.exe"), "incomplete");
          if (fault === "toolchain") {
            const file = path.join(cache, key, "manifest.json");
            const manifest = JSON.parse(await readFile(file, "utf8"));
            manifest.toolchain = "different-runtime";
            await writeFile(file, JSON.stringify(manifest));
          }
        }
        const result = await rawOwner(t, root, {
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        });
        assert.notEqual(result.code, 0);
        assert.doesNotMatch(result.stderr, /:active\u001f/);
        await assert.rejects(access(marker), { code: "ENOENT" });
        const cache = path.join(root, ".tools", "command-owner-native-v1");
        assert.ok((await readdir(cache)).every((name) => !name.startsWith("prepare-")));
      });
    }
  });

test("a changed compiler toolchain cannot reuse a previously successful native artifact",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await ownerFixture(t);
    await prepareOwner(t, root);
    const frameworkParts = ["Microsoft.NET", "Framework64", "v4.0.30319"];
    const original = path.join(process.env.SystemRoot ?? process.env.WINDIR, ...frameworkParts);
    const systemRoot = path.join(root, "changed-toolchain"), selected = path.join(systemRoot, ...frameworkParts);
    await mkdir(selected, { recursive: true });
    for (const file of ["csc.exe", "csc.exe.config", "csc.rsp", "clr.dll", "mscorlib.dll", "System.Runtime.Serialization.dll"]) {
      await copyFile(path.join(original, file), path.join(selected, file));
    }
    await writeFile(path.join(selected, "csc.exe"), "invalid compiler fixture");
    const entry = path.join(root, "changed-toolchain.mjs");
    await writeFile(entry, [
      "import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';",
      // OpenSSL initializes its Windows entropy provider using the real system directory.
      "import {randomUUID} from 'node:crypto';randomUUID();",
      "const operatingSystemEnvironment={...process.env};const spawn=childProcess.spawn;",
      `process.env.SystemRoot=${JSON.stringify(systemRoot)};`,
      // Only toolchain discovery sees the fixture; OS processes still need the real system directory.
      "childProcess.spawn=(file,args,options)=>spawn(file,args,{...options,env:operatingSystemEnvironment});",
      "syncBuiltinESMExports();",
      `await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts", "owned-command-windows.mjs")).href)});`,
    ].join("\n"));
    const marker = path.join(root, "must-not-exist");
    const result = await rawOwner(t, root, { entry,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Windows ownership helper preparation failed/);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal((await readdir(path.join(root, ".tools", "command-owner-native-v1"))).length, 1,
      "A failed different toolchain cannot publish an artifact or reuse the previous one.");
  });
