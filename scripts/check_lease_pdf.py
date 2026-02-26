import re

with open("N-forms/Standard-lease-Ontario_template.xml", "r", encoding="utf-8", errors="replace") as f:
    content = f.read()

fields = re.findall(r'<field[^>]*name="([^"]+)"', content)
unique = sorted(set(fields))
print(f"Total unique fields: {len(unique)}")
for field in unique:
    print(field)
