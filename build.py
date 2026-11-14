from pathlib import Path
import argparse, os, re, subprocess, sys, tempfile

if sys.version_info < (3, 8):
    raise SystemExit('Python 3.8+ is required')

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'src'
DIST = ROOT / 'dist'
VERSION = '1.0'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', action='store_true')
    parser.add_argument('--webview2', type=Path, default=None)
    args = parser.parse_args()

    DIST.mkdir(parents=True, exist_ok=True)
    html_path = DIST / f'HerosAdventureSaveEditor-v{VERSION}.html'

    html = (SRC / 'editor-page.html').read_text(encoding='utf-8')
    START = '<!-- BUNDLE_SCRIPTS_START -->'
    END = '<!-- BUNDLE_SCRIPTS_END -->'

    i = html.find(START)
    j = html.find(END, i + len(START)) if i != -1 else -1
    if i < 0 or j < 0:
        raise SystemExit('Missing bundle markers')

    parts = []
    for name in ('catalog-data.js', 'es3-codec.js', 'editor-core.js', 'editor-ui.js'):
        js = (SRC / name).read_text(encoding='utf-8')
        js = re.sub(r'</(script)', lambda m: '<\\/' + m.group(1), js, flags=re.IGNORECASE)
        parts.append(f'<script>\n{js}\n</script>')
    block = '\n'.join(parts)

    out_html = html[:i] + block + html[j + len(END):]
    assert 'http://' not in out_html and 'https://' not in out_html
    with open(html_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(out_html)
    print(f'Built {html_path.name} ({html_path.stat().st_size} bytes)')

    if args.exe:
        if not args.webview2:
            raise SystemExit('--webview2 is required with --exe')

        sdk = args.webview2.resolve()
        required = (
            'Microsoft.Web.WebView2.Core.dll',
            'Microsoft.Web.WebView2.WinForms.dll',
            'WebView2Loader.dll',
            'LICENSE.txt',
        )
        for name in required:
            if not (sdk / name).is_file():
                raise SystemExit(f'Missing WebView2 SDK file: {name}')

        csc = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        exe_name = f'HerosAdventureSaveEditor-v{VERSION}.exe'

        def _q(p):
            return '"' + str(p).replace('"', '\\"') + '"'

        cmd = [
            '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-',
            f'/out:{_q(DIST / exe_name)}',
            '/reference:"System.Windows.Forms.dll"',
            '/reference:"System.Drawing.dll"',
            '/reference:"System.Web.Extensions.dll"',
            f'/reference:{_q(sdk / "Microsoft.Web.WebView2.Core.dll")}',
            f'/reference:{_q(sdk / "Microsoft.Web.WebView2.WinForms.dll")}',
            f'/resource:{_q(sdk / "Microsoft.Web.WebView2.Core.dll")},Microsoft.Web.WebView2.Core.dll',
            f'/resource:{_q(sdk / "Microsoft.Web.WebView2.WinForms.dll")},Microsoft.Web.WebView2.WinForms.dll',
            f'/resource:{_q(sdk / "WebView2Loader.dll")},WebView2Loader.dll',
            f'/resource:{_q(sdk / "LICENSE.txt")},WebView2-LICENSE.txt',
            f'/resource:{_q(html_path)},editor.html',
            _q(SRC / 'SaveEditor.cs'),
            _q(SRC / 'SaveStore.cs'),
        ]
        rsp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode='w',
                encoding='utf-8-sig',
                newline='\n',
                suffix='.rsp',
                dir=str(DIST),
                delete=False,
            ) as rsp_file:
                rsp_path = rsp_file.name
                rsp_file.write('\n'.join(cmd))
                rsp_file.write('\n')
            subprocess.run([str(csc), f'@{rsp_path}'], check=True, cwd=ROOT)
            print(f'Built {exe_name}')
        finally:
            if rsp_path is not None:
                try:
                    os.unlink(rsp_path)
                except OSError:
                    pass


if __name__ == '__main__':
    main()
