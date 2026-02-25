#!/usr/bin/env python3
"""
fill_xfa.py — Fill XFA-based Ontario LTB N-form PDF templates.

Reads JSON from stdin:
  { "template": "N-forms/N4.pdf", "output": "/tmp/filled.pdf", "fields": { "TO_TenameName": "John", ... } }

Injects field values into the XFA datasets stream and writes the filled PDF.
"""

import json
import sys
import os
import re
import pikepdf

def fill_xfa_pdf(template_path: str, output_path: str, fields: dict) -> None:
    """Open an XFA PDF template, inject field values into the datasets stream, and save."""
    pdf = pikepdf.open(template_path)
    root = pdf.Root
    
    if '/AcroForm' not in root:
        raise ValueError(f"No AcroForm found in {template_path}")
    
    acro = root['/AcroForm']
    if '/XFA' not in acro:
        raise ValueError(f"No XFA data found in {template_path}")
    
    xfa = acro['/XFA']
    if not isinstance(xfa, pikepdf.Array):
        raise ValueError("XFA is not an array")
    
    # Find the datasets stream
    datasets_idx = None
    for i in range(0, len(xfa), 2):
        key = str(xfa[i])
        if key == 'datasets':
            datasets_idx = i + 1
            break
    
    if datasets_idx is None:
        raise ValueError("No datasets segment found in XFA")
    
    datasets_stream = xfa[datasets_idx]
    datasets_xml = datasets_stream.read_bytes().decode('utf-8')
    
    # Parse and update the datasets XML
    updated_xml = inject_fields_into_datasets(datasets_xml, fields)
    
    # Write the updated datasets back into the PDF stream
    datasets_stream.write(updated_xml.encode('utf-8'))
    
    # Also need to remove the NeedsRendering flag if present
    if '/NeedsRendering' in root:
        root['/NeedsRendering'] = pikepdf.Name('/true')
    else:
        root[pikepdf.Name('/NeedsRendering')] = True
    
    pdf.save(output_path)
    pdf.close()


def inject_fields_into_datasets(datasets_xml: str, fields: dict) -> str:
    """
    Inject field values into the XFA datasets XML.
    
    Handles:
    - Simple fields: <FieldName/> -> <FieldName>value</FieldName>
    - Fields with existing values: <FieldName>old</FieldName> -> <FieldName>new</FieldName>
    - Nested table fields like Table1.Row1.ArrearFrom1
    """
    
    for field_path, value in fields.items():
        if value is None or value == '':
            continue
            
        value_str = str(value)
        # Escape XML special characters
        value_str = value_str.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        
        if '.' in field_path:
            # Handle nested fields like Table1.Row1.ArrearFrom1
            parts = field_path.split('.')
            field_name = parts[-1]
            datasets_xml = _set_nested_field(datasets_xml, parts, value_str)
        else:
            # Simple field replacement
            # Match self-closing tag: <FieldName/> or <FieldName\n/>
            pattern_empty = re.compile(
                r'(<' + re.escape(field_path) + r')(\s*/\s*>)', 
                re.DOTALL
            )
            if pattern_empty.search(datasets_xml):
                replacement_empty = r'\g<1>>' + value_str + '</' + field_path + '>'
                datasets_xml = pattern_empty.sub(replacement_empty, datasets_xml, count=1)
            else:
                # Match tag with existing content: <FieldName>old</FieldName>
                pattern_filled = re.compile(
                    r'(<' + re.escape(field_path) + r'\s*>)[^<]*(</\s*' + re.escape(field_path) + r'\s*>)',
                    re.DOTALL
                )
                datasets_xml = pattern_filled.sub(
                    r'\g<1>' + value_str + r'\g<2>', 
                    datasets_xml, 
                    count=1
                )
    
    return datasets_xml


def _set_nested_field(xml: str, parts: list, value: str) -> str:
    """Set a value for a nested field path like ['Table1', 'Row1', 'ArrearFrom1']."""
    field_name = parts[-1]
    
    # Find the innermost container and the field within it
    container = parts[-2] if len(parts) > 1 else None
    
    if container:
        # XFA XML uses newlines inside tags like <Row1\n> and </Row1\n>
        # so we need \s* after the tag name and before >
        container_pattern = re.compile(
            r'(<' + re.escape(container) + r'[^>]*>)(.*?)(</' + re.escape(container) + r'\s*>)',
            re.DOTALL
        )
        
        def replace_in_container(match):
            prefix = match.group(1)
            content = match.group(2)
            suffix = match.group(3)
            
            # Self-closing: <FieldName\n/> or <FieldName/>
            empty_pat = re.compile(r'(<' + re.escape(field_name) + r')(\s*/\s*>)')
            if empty_pat.search(content):
                content = empty_pat.sub(
                    r'\g<1>>' + value + '</' + field_name + r'>',
                    content, count=1
                )
            else:
                # Has content: <FieldName>old</FieldName> or <FieldName\n>old</FieldName\n>
                filled_pat = re.compile(
                    r'(<' + re.escape(field_name) + r'\s*>)[^<]*(</\s*' + re.escape(field_name) + r'\s*>)'
                )
                content = filled_pat.sub(
                    r'\g<1>' + value + r'\g<2>',
                    content, count=1
                )
            
            return prefix + content + suffix
        
        xml = container_pattern.sub(replace_in_container, xml, count=1)
    
    return xml


def main():
    input_data = json.loads(sys.stdin.read())
    
    template = input_data['template']
    output = input_data['output']
    fields = input_data['fields']
    
    if not os.path.exists(template):
        print(json.dumps({"error": f"Template not found: {template}"}))
        sys.exit(1)
    
    try:
        fill_xfa_pdf(template, output, fields)
        print(json.dumps({"ok": True, "output": output}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
