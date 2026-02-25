"""
Comprehensive XFA field scan for all N-form PDFs.
Extracts ALL fillable field names from the XFA datasets XML stream.
"""
import pikepdf
import os
import re
from lxml import etree

forms_dir = 'N-forms'

for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('.pdf'):
        continue
    form_name = fname.replace('.pdf', '')
    path = os.path.join(forms_dir, fname)
    
    try:
        pdf = pikepdf.open(path)
    except Exception as e:
        print(f"\n=== {form_name} === ERROR: {e}")
        continue
    
    # Get XFA array
    try:
        acroform = pdf.Root.get("/AcroForm")
        if not acroform:
            print(f"\n=== {form_name} === No AcroForm")
            continue
        xfa = acroform.get("/XFA")
        if not xfa:
            print(f"\n=== {form_name} === No XFA")
            continue
    except Exception as e:
        print(f"\n=== {form_name} === ERROR: {e}")
        continue
    
    # Find datasets stream
    datasets_xml = None
    xfa_list = list(xfa)
    for i in range(0, len(xfa_list)-1, 2):
        key = str(xfa_list[i])
        if key == "datasets":
            stream = xfa_list[i+1]
            datasets_xml = stream.read_bytes().decode('utf-8', errors='replace')
            break
    
    if not datasets_xml:
        print(f"\n=== {form_name} === No datasets stream")
        continue
    
    print(f"\n{'='*60}")
    print(f"  {form_name}")
    print(f"{'='*60}")
    
    # Parse XML
    try:
        root = etree.fromstring(datasets_xml.encode('utf-8'))
    except Exception:
        # Try removing namespace issues
        cleaned = re.sub(r'xmlns[^=]*="[^"]*"', '', datasets_xml)
        root = etree.fromstring(cleaned.encode('utf-8'))
    
    # Walk all elements under the data section, collect leaf paths
    def walk(el, path=""):
        tag = etree.QName(el.tag).localname if '}' in el.tag else el.tag
        current = f"{path}.{tag}" if path else tag
        
        children = list(el)
        if not children:
            # Leaf node = fillable field
            text = (el.text or "").strip()
            print(f"  {current} = '{text}'")
        else:
            for child in children:
                walk(child, current)
    
    # Find the form1 or data element
    for el in root.iter():
        tag = etree.QName(el.tag).localname if '}' in el.tag else el.tag
        if tag == 'form1':
            walk(el, "")
            break
    else:
        # If no form1, dump everything under data
        for el in root.iter():
            tag = etree.QName(el.tag).localname if '}' in el.tag else el.tag
            if tag == 'data':
                for child in el:
                    walk(child, "")
                break
    
    pdf.close()
