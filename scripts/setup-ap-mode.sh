#!/bin/bash
# Setup Access Point Mode for WiFi Configuration

echo "🔧 Configurando Modo AP para WiFi Fallback..."

# Install required packages
sudo apt install -y hostapd dnsmasq

# Stop services to configure them
sudo systemctl stop hostapd
sudo systemctl stop dnsmasq

# Backup original configs
sudo cp /etc/dhcpcd.conf /etc/dhcpcd.conf.backup
sudo cp /etc/dnsmasq.conf /etc/dnsmasq.conf.backup

# Configure static IP for wlan0 in AP mode
echo "
# Static IP for AP mode
interface wlan0
static ip_address=192.168.4.1/24
nohook wpa_supplicant
" | sudo tee -a /etc/dhcpcd.conf

# Configure dnsmasq
echo "
# AP Mode Configuration
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h
domain=local
address=/bascula.local/192.168.4.1
" | sudo tee /etc/dnsmasq.conf

# Configure hostapd
echo "
interface=wlan0
driver=nl80211
ssid=Bascula-AP
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=bascula2025
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
" | sudo tee /etc/hostapd/hostapd.conf

# Point hostapd to config file
sudo sed -i 's|#DAEMON_CONF=""|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# Enable IP forwarding
sudo sed -i 's/#net.ipv4.ip_forward=1/net.ipv4.ip_forward=1/' /etc/sysctl.conf
sudo sysctl -p

# Add iptables rules for NAT
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -i eth0 -o wlan0 -m state --state RELATED,ESTABLISHED -j ACCEPT
sudo iptables -A FORWARD -i wlan0 -o eth0 -j ACCEPT

# Save iptables rules
sudo sh -c "iptables-save > /etc/iptables.ipv4.nat"

# Load iptables rules on boot
echo "
#!/bin/sh
iptables-restore < /etc/iptables.ipv4.nat
" | sudo tee /etc/rc.local
sudo chmod +x /etc/rc.local

# Don't enable services by default - they will be enabled by network detector
sudo systemctl unmask hostapd
sudo systemctl disable hostapd
sudo systemctl disable dnsmasq

echo "✅ Modo AP configurado"
echo "📡 SSID: Bascula-AP"
echo "🔐 Password: bascula2025"
echo "📍 IP: 192.168.4.1"
echo ""
echo "⚠️  Los servicios NO se inician automáticamente"
echo "💡 Se activarán automáticamente cuando no haya red WiFi"
