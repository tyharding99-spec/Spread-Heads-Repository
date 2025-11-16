const AsyncStorage = require('@react-native-async-storage/async-storage');

const resetApp = async () => {
    try {
        console.log('Starting app reset...');
        await AsyncStorage.clear();
        console.log('Successfully cleared AsyncStorage');
        return true;
    } catch (error) {
        console.error('Error resetting app:', error);
        return false;
    }
};

resetApp();