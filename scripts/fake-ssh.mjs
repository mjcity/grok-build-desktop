/* Test stand-in for ssh.exe, used via FROZEN_SSH_CMD='["<node>","<this file>"]'.
 * It receives exactly the argv the gateway would pass to ssh
 * (…options, target, "<remote command>") and forwards the remote command to the
 * mock LM Studio's /__mock/lms endpoint, which emulates the `lms` CLI.
 * Never contacts a real machine. Needs FAKE_SSH_MOCK_PORT. */
const port = process.env.FAKE_SSH_MOCK_PORT;
const command = process.argv[process.argv.length - 1] || "";

if (!port) {
  process.stderr.write("fake-ssh: FAKE_SSH_MOCK_PORT not set\n");
  process.exit(255);
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/__mock/lms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const r = await res.json();
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(Number.isInteger(r.code) ? r.code : 1);
} catch (e) {
  process.stderr.write(`fake-ssh: mock unreachable: ${e.message}\n`);
  process.exit(255);
}
