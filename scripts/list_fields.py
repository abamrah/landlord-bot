import re
import os

forms_dir = 'N-forms'
for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith('_template.xml'):
        continue
    form_name = fname.replace('_template.xml', '')
    path = os.path.join(forms_dir, fname)
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f'\n=== {form_name} ===')
    
    # Find all field elements with their names
    fields = re.findall(r'<field\s+[^>]*name="([^"]+)"', content)
    print(f'Fields: {len(fields)}')
    for field in fields:
        print(f'  field: {field}')
    
    # Find exclusionGroup names (radio button groups)
    excl = re.findall(r'<exclGroup\s+[^>]*name="([^"]+)"', content)
    if excl:
        print(f'ExclGroups: {len(excl)}')
        for e in excl:
            print(f'  exclGroup: {e}')
