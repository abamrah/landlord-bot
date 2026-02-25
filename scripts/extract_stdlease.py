"""Extract Standard Lease fields."""
import pikepdf, re
from lxml import etree

pdf = pikepdf.open('N-forms/Standard-lease-Ontario.pdf')
acroform = pdf.Root.get('/AcroForm')
xfa = acroform.get('/XFA')
xfa_list = list(xfa)
for i in range(0, len(xfa_list)-1, 2):
    if str(xfa_list[i]) == 'datasets':
        xml = xfa_list[i+1].read_bytes().decode('utf-8', errors='replace')
        cleaned = re.sub(r'\bxmlns="[^"]*"', '', xml)
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
        non_guide = [(p.replace('form1.','',1), v) for p,v in fields if '.Guide.' not in p and 'guide' not in p.lower() and 'navigationBtn' not in p]
        print(f'=== Standard-lease-Ontario ({len(non_guide)} fields) ===')
        for p, v in non_guide:
            print(f'  {p}')
        break
pdf.close()
