import pikepdf
import os

forms_dir = 'N-forms'
for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('.pdf'):
        continue
    path = os.path.join(forms_dir, fname)
    form_name = fname.replace('.pdf', '')
    print(f'\n=== {form_name} ===')
    pdf = pikepdf.open(path)
    acro = pdf.Root['/AcroForm']
    xfa = acro['/XFA']
    if isinstance(xfa, pikepdf.Array):
        for i in range(0, len(xfa), 2):
            key = str(xfa[i])
            stream = xfa[i+1]
            if hasattr(stream, 'read_bytes') and key == 'datasets':
                data = stream.read_bytes().decode('utf-8', errors='replace')
                print(data)
    pdf.close()
