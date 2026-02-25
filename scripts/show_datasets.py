import pikepdf
import os

forms_dir = 'N-forms'
for fname in ['N4.pdf', 'N1.pdf', 'N11.pdf', 'N12.pdf']:
    path = os.path.join(forms_dir, fname)
    print(f'\n=== {fname} ===')
    pdf = pikepdf.open(path)
    acro = pdf.Root['/AcroForm']
    xfa = acro['/XFA']
    if isinstance(xfa, pikepdf.Array):
        for i in range(0, len(xfa), 2):
            key = str(xfa[i])
            stream = xfa[i+1]
            if hasattr(stream, 'read_bytes'):
                data = stream.read_bytes().decode('utf-8', errors='replace')
                if key in ('datasets', 'form'):
                    print(f'\n--- {key} ({len(data)} bytes) ---')
                    print(data[:2000])
    pdf.close()
