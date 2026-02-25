import pikepdf
import os

forms_dir = 'N-forms'
for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('.pdf'):
        continue
    path = os.path.join(forms_dir, fname)
    print(f'=== {fname} ===')
    try:
        pdf = pikepdf.open(path)
        root = pdf.Root
        if '/AcroForm' in root:
            acro = root['/AcroForm']
            print(f'  AcroForm keys: {list(acro.keys())}')
            if '/XFA' in acro:
                print('  Has XFA!')
                xfa = acro['/XFA']
                if isinstance(xfa, pikepdf.Array):
                    for i in range(0, len(xfa), 2):
                        key = str(xfa[i])
                        stream = xfa[i+1]
                        if hasattr(stream, 'read_bytes'):
                            data = stream.read_bytes()
                            print(f'  XFA segment [{key}]: {len(data)} bytes')
                            if key == 'template':
                                base = fname.replace('.pdf', '_template.xml')
                                out = os.path.join('N-forms', base)
                                with open(out, 'wb') as f:
                                    f.write(data)
                                print(f'    -> saved template XML')
            if '/Fields' in acro:
                fields = acro['/Fields']
                print(f'  AcroForm fields: {len(fields)}')
        else:
            print('  No AcroForm')
        pdf.close()
    except Exception as e:
        print(f'  Error: {e}')
