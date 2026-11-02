export function plaintextPasswordList(entries) {
  // Escape control characters so every credential stays on one printable row.
  const cell = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  const rows = [...entries]
    .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'es', { sensitivity: 'base', numeric: true }))
    .map((entry) => [cell(entry.title), cell(entry.username), cell(entry.password)]);
  const headers = ['Nombre', 'Usuario', 'Contraseña'];
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((value, i) => i < 2 ? value.padEnd(widths[i]) : value).join('  |  ');
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('--|--'), ...rows.map(line)].join('\r\n') + '\r\n';
}
