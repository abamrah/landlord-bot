"""Extract all XFA dataset fields from N-form PDFs, excluding guide sections."""
import pikepdf, os, re
from lxml import etree

forms_dir = 'N-forms'
for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('.pdf'):
        continue
    form_name = fname.replace('.pdf', '')
    if 'Standard' in form_name:
        continue
    path = os.path.join(forms_dir, fname)
    try:
        pdf = pikepdf.open(path)
        acroform = pdf.Root.get('/AcroForm')
        xfa = acroform.get('/XFA')
        xfa_list = list(xfa)
        datasets_xml = None
        for i in range(0, len(xfa_list)-1, 2):
            if str(xfa_list[i]) == 'datasets':
                datasets_xml = xfa_list[i+1].read_bytes().decode('utf-8', errors='replace')
                break
        if not datasets_xml:
            continue
        # Remove default xmlns but keep xfa prefix
        cleaned = re.sub(r'\bxmlns="[^"]*"', '', datasets_xml)
        cleaned = re.sub(r'\bxmlns:xfa="[^"]*"', 'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"', cleaned)
        root = etree.fromstring(cleaned.encode('utf-8'))
        fields = []
        def walk(el, path=''):
            tag = etree.QName(el.tag).localname if '}' in el.tag else el.tag
            current = f'{path}.{tag}' if path else tag
            children = list(el)
            if not children:
                text = (el.text or '').strip()
                fields.append((current, text))
            else:
                for child in children:
                    walk(child, current)
        for el in root.iter():
            tag = etree.QName(el.tag).localname if '}' in el.tag else el.tag
            if tag == 'form1':
                walk(el, '')
                break
        non_guide = [(p.replace('form1.','',1) if p.startswith('form1.') else p, v) 
                     for p,v in fields 
                     if '.Guide.' not in p and 'guide' not in p.lower() and 'navigationBtn' not in p]
        print(f'\n=== {form_name} ({len(non_guide)} fields) ===')
        for p, v in non_guide:
            print(f'  {p} = {repr(v)}')
        pdf.close()
    except Exception as e:
        print(f'\n=== {form_name} ERROR: {e} ===')
