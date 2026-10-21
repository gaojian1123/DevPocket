using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Reflection;
using System.Runtime.InteropServices;

public static class SupervisorContracts {
    static Dictionary<string, object> Request(string root, string node) {
        return new Dictionary<string, object> {
            { "version", 1 }, { "id", Guid.NewGuid().ToString() }, { "file", node }, { "cwd", root },
            { "identity", Path.Combine(root, "identity.json") }, { "timeoutMs", 1000 },
            { "arguments", new[] { "--disable-sigusr1", "-e", "process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')" } },
            { "environment", new Dictionary<string, object> { { "PATH", root } } }
        };
    }

    static void Reject(Action action) {
        try { action(); } catch (InvalidDataException) { return; }
        throw new Exception("Invalid or candidate-controlled probe input was accepted.");
    }

    public static int Main(string[] args) {
        var query = typeof(DevPocketWindowsSupervisor).GetMethod("QueryServiceStatusEx", BindingFlags.Static | BindingFlags.NonPublic);
        if (query == null || query.GetParameters()[0].ParameterType != typeof(SafeHandle))
            throw new Exception("SCM queries must retain a marshaler-protected service handle.");
        string root = Path.GetFullPath(args[0]), node = Path.Combine(root, "synthetic-node.exe");
        byte[] bytes = Encoding.UTF8.GetBytes("not an executable; validation must never launch it");
        File.WriteAllBytes(node, bytes);
        var configuration = new Dictionary<string, object> {
            { "probeNode", node }, { "probeNodeSha256", DevPocketWindowsSupervisor.Digest(bytes) },
            { "probeCwd", root }, { "identity", Path.Combine(root, "identity.json") }
        };
        DevPocketWindowsSupervisor.ValidateProbeRequest(configuration, Request(root, node));
        foreach (string field in new[] { "version", "id", "file", "cwd", "identity", "timeoutMs", "arguments", "environment", "extra" }) {
            var request = Request(root, node);
            switch (field) {
                case "version": request[field] = 2; break;
                case "timeoutMs": request[field] = 30001; break;
                case "arguments": request[field] = new[] { "-e", "process.exit(0)" }; break;
                case "environment": request[field] = new Dictionary<string, object> { { "NODE_OPTIONS", "--require candidate.cjs" } }; break;
                default: request[field] = "unbound"; break;
            }
            Reject(() => DevPocketWindowsSupervisor.ValidateProbeRequest(configuration, request));
        }
        foreach (object value in new object[] { null, 1, "bad\0value" }) {
            var request = Request(root, node);
            request["environment"] = new Dictionary<string, object> { { "PATH", value } };
            Reject(() => DevPocketWindowsSupervisor.ValidateProbeRequest(configuration, request));
        }
        File.AppendAllText(node, "changed");
        Reject(() => DevPocketWindowsSupervisor.ValidateProbeRequest(configuration, Request(root, node)));
        var complete = new Dictionary<string, object> {
            { "version", 1 }, { "service", "dpws_" + new string('a', 24) },
            { "serviceSid", "S-1-5-80-1-2-3-4-5" }, { "runnerSid", "S-1-5-21-1-2-3-1001" }, { "ownerPid", 123 },
            { "ownerPipe", "devpocket-" + new string('b', 32) + "-owner" },
            { "commandPipe", "devpocket-" + new string('b', 32) + "-command" }, { "nonce", new string('c', 64) },
            { "privateRoot", root }, { "identity", Path.Combine(root, "identity.json") },
            { "executableSha256", DevPocketWindowsSupervisor.Digest(File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName)) },
            { "probeNode", node }, { "probeNodeSha256", DevPocketWindowsSupervisor.Digest(bytes) }, { "probeCwd", root }
        };
        string file = Path.Combine(root, "supervisor.json");
        byte[] encoded = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(complete));
        File.WriteAllBytes(file, encoded);
        DevPocketWindowsSupervisor.ReadConfiguration(file, DevPocketWindowsSupervisor.Digest(encoded));
        Reject(() => DevPocketWindowsSupervisor.ReadConfiguration(file, new string('0', 64)));
        complete["unexpected"] = true;
        encoded = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(complete));
        File.WriteAllBytes(file, encoded);
        Reject(() => DevPocketWindowsSupervisor.ReadConfiguration(file, DevPocketWindowsSupervisor.Digest(encoded)));
        Console.WriteLine("SUPERVISOR_VALIDATION_ONLY");
        return 0;
    }
}
