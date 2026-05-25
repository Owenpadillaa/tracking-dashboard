import re
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    with open(fname,'r',encoding='utf-8',newline='') as f:
        content = f.read()
    # Find all @keyframes definitions
    print(f'=== {fname} ===')
    for i,line in enumerate(content.split('\n'),1):
        stripped = line.strip()
        if '@keyframes' in stripped:
            print(f'  {i}: {stripped}')
    # Find any animation-name applied to .tab-page
    for i,line in enumerate(content.split('\n'),1):
        stripped = line.strip()
        if '.tab-page' in stripped and 'animation' in stripped:
            print(f'  {i} [tab-page animation]: {stripped}')