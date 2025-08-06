## NFC writes 

### For android 

Write a custom record:
```
Content-type : application/vnd.fov.device
Data         : FOV-ESP32-01
```

### For IOS 

Write a URI:
```
Type : URI
URI  : fovconnector://FOV-ESP32-01
```

### Port connection errors 

Its likely just due to the firewall if you get anything like:

"failed to connect to 192.168.21.0 (port 8082) from 192.168.21.201 (port 30134)" 