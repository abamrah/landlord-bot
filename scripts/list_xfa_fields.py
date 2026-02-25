import os
import xml.etree.ElementTree as ET

forms_dir = 'N-forms'
ns = {'t': 'http://www.xfa.org/schema/xfa-template/3.3/'}

for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('_template.xml'):
        continue
    form_name = fname.replace('_template.xml', '')
    path = os.path.join(forms_dir, fname)
    print(f'\n=== {form_name} ===')
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        
        # Find all field elements
        fields = root.findall('.//t:field', ns)
        print(f'Total fields: {len(fields)}')
        for field in fields:
            name = field.get('name', '(unnamed)')
            # Get the UI element to determine type
            ui = field.find('t:ui', ns)
            ui_type = 'unknown'
            if ui is not None:
                for child in ui:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    ui_type = tag
                    break
            # Get caption/label
            caption = field.find('.//t:caption//t:text/t:value', ns)
            if caption is None:
                caption = field.find('.//t:caption', ns)
            cap_text = ''
            if caption is not None and caption.text:
                cap_text = caption.text.strip()[:60]
            
            print(f'  [{ui_type:12}] {name:40} | {cap_text}')
    except Exception as e:
        print(f'  Error: {e}')
