# ImobiGest

MVP em português para gestão de imóveis, receitas e despesas, contratos, reservas manuais, fotos e relatórios. Desenvolvido em HTML, CSS e JavaScript Vanilla, com ES Modules e IndexedDB, sem instalação de dependências.

## Abrir a aplicação

No VS Code, abra `index.html` usando **Open with Live Server**. Também funciona em hospedagem estática HTTPS, como GitHub Pages. Abrir diretamente por `file://` não é suportado pelos módulos JavaScript.

## Ativar o GitHub Pages

1. No repositório `viniorc/ImobiGest`, abra **Settings → Pages**.
2. Em **Build and deployment**, selecione **Deploy from a branch**.
3. Selecione a branch **main** e a pasta **/ (root)** e clique **Save**.
4. Aguarde a publicação e abra **https://viniorc.github.io/ImobiGest/**.

Os caminhos dos recursos são relativos e a navegação usa hash, permitindo servir a aplicação na subpasta do repositório. O arquivo `.nojekyll` permite a entrega dos arquivos estáticos sem processamento pelo Jekyll.

## Começar a usar

1. Cadastre seus imóveis em **Meus Imóveis**.
2. Registre receitas e despesas em **Financeiro**, com imóvel opcional para lançamentos gerais. Somente valores liquidados entram no resultado realizado; contratos e reservas não são recebimentos por si só.
3. Em **Aluguéis**, cadastre contratos e gere cobranças previstas explicitamente. Em **Reservas**, cadastre hospedagens manualmente e gere seus lançamentos quando desejar.
4. Adicione fotos, legendas e capas em **Fotos** ou na ficha do imóvel. As imagens são reduzidas localmente; guarde os arquivos originais à parte.
5. Consulte **Dashboard** e **Relatórios**, ajuste filtros, exporte CSV ou use a impressão do navegador para salvar PDF.

Não há integração com Airbnb/Booking, pagamentos, contabilidade fiscal ou sincronização. O resultado apresentado é fluxo de caixa operacional, não lucro contábil ou valorização patrimonial.

## Dados locais e backup

Os registros e fotos ficam **somente no navegador, perfil e dispositivo utilizados**, em IndexedDB. O GitHub Pages hospeda o código e não recebe seus cadastros. Não existe conta, autenticação, armazenamento remoto ou sincronização entre dispositivos.

Limpar dados do navegador, usar modo privado, trocar de perfil/dispositivo ou perder o dispositivo pode eliminar os registros. Live Server e GitHub Pages têm origens diferentes: os dados cadastrados localmente não aparecem automaticamente na versão publicada. Exporte um backup e restaure-o no destino para transferi-los.

Em **Configurações**, clique **Exportar backup completo** e guarde o JSON fora do navegador, de preferência também em outro dispositivo. O arquivo inclui fotos e dados pessoais e **não é criptografado**. Nunca coloque seus backups no repositório público.

Para restaurar, selecione o JSON, confira a prévia e confirme a substituição da base. Guarde uma cópia da base atual antes de substituir e feche outras abas da aplicação. A restauração valida referências e é atômica: se a transação falhar, os dados anteriores são preservados. Teste primeiro em perfil separado. O limite de importação é 100 MiB; memória e quota disponíveis variam conforme o navegador.

## Demonstração

Em **Configurações → Ativar demonstração**, abra um conjunto de cinco imóveis fictícios em banco separado, identificado como **Modo demonstração**. A demonstração não é ativada automaticamente. Use **Voltar aos dados reais** para retornar; uma recarga normal também retorna aos dados reais. **Limpar demonstração** exige confirmação e atua somente no banco demonstrativo.

## Verificações

Abra `tests/todas.html` pelo mesmo servidor ou use **Configurações → Diagnóstico → Executar regressão completa do sistema**. Clique **Executar todas as verificações**. Referência da revisão do MVP: **270 testes aprovados**, cobrindo datas civis, centavos, persistência, contratos, reservas, fotos, relatórios e recuperação. As suítes criam bancos descartáveis e não usam as bases real e de demonstração.

Confira também manualmente os menus, formulários, teclado, larguras de 1440/768/375 px, CSV no Excel e a prévia de impressão no seu navegador. A aprovação automatizada não garante funcionamento em todos os dispositivos. A extensão Live Server, o aplicativo Excel e dispositivos físicos não fizeram parte da validação automatizada registrada.

Este repositório contém o código da aplicação e seus testes, sem o kit de prompts e os documentos internos de desenvolvimento.
