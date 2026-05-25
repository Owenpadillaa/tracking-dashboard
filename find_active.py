import re
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    with open(fname,'r',encoding='utf-8',newline='') as f:
        content = f.read()
    # Find any .tab-page related rule with opacity or display
    for m in re.finditer(r'[^\n]*tab-page[^\n]*\n[^\n]*', content):
        line = m.group(0)
        if ('opacity' in line or 'display' in line.lower()) and ':' in line:
            print(f'{fname}: {line.strip()[:120]}')