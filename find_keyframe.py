import re
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    with open(fname,'r',encoding='utf-8',newline='') as f:
        content = f.read()
    # Find @keyframes fadeUp
    idx = content.find('@keyframes fadeUp')
    if idx >= 0:
        snippet = content[idx:idx+300]
        print(f'{fname}: @keyframes fadeUp found')
        print(snippet)
        print()
    # Also check for any .tab-page.active rule
    matches = list(re.finditer(r'\btab-page\b[^\n]*\n[^\n]*', content))
    for m in matches:
        line = m.group(0).strip()
        if 'active' in line and ('opacity' in line or 'display' in line.lower()):
            print(f'{fname}: {line}')